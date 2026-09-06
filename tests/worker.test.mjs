import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const origin = 'https://docker.example.com';
const repo = 'veildawn/ai-proxy-release';
const digest = `sha256:${'a'.repeat(64)}`;
const invoke = (path, init) => worker.fetch(new Request(new URL(path, origin), init), {}, {});

function mockFetch(t, handler) {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => handler(new Request(input, init));
	t.after(() => { globalThis.fetch = original; });
}

test('GHCR search uses scoped GitHub tokens, cursor pagination and prefixed pull names', async t => {
	const calls = [];
	mockFetch(t, request => {
		const url = new URL(request.url);
		calls.push(url);
		assert.equal(url.hostname, 'ghcr.io');
		if (url.pathname === '/token') {
			assert.equal(url.searchParams.get('service'), 'ghcr.io');
			assert.equal(url.searchParams.get('scope'), `repository:${repo}:pull`);
			assert.equal(request.headers.get('Authorization'), null);
			return Response.json({ token: 'github-token' });
		}
		assert.equal(request.headers.get('Authorization'), 'Bearer github-token');
		assert.equal(url.pathname, `/v2/${repo}/tags/list`);
		assert.equal(url.searchParams.get('n'), '25');
		assert.equal(url.searchParams.get('last'), 'v1');
		return Response.json({ tags: ['latest', 'v2'] }, {
			headers: { Link: `</v2/${repo}/tags/list?n=25&last=v2>; rel="next"` },
		});
	});
	const response = await invoke(`/v1/search?q=ghcr.io/${repo}&last=v1`);
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.registry, 'ghcr.io');
	assert.equal(data.next_last, 'v2');
	assert.equal(data.results[0].name, `ghcr.io/${repo}:latest`);
	assert.equal(calls.length, 2);
});

test('explicit GHCR tags and digests query manifests rather than all tags', async t => {
	let expected;
	mockFetch(t, request => {
		const url = new URL(request.url);
		if (url.pathname === '/token') return Response.json({ token: 'github-token' });
		assert.equal(url.pathname, `/v2/${repo}/manifests/${expected}`);
		assert.match(request.headers.get('Accept'), /oci.image.index/);
		return Response.json({ schemaVersion: 2 });
	});
	for (const [suffix, reference] of [[':v1.0', 'v1.0'], [`@${digest}`, digest]]) {
		expected = reference;
		const response = await invoke(`/v1/search?q=${encodeURIComponent(`https://ghcr.io/${repo}${suffix}`)}`);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).results[0].name, `ghcr.io/${repo}${suffix}`);
	}
});

test('path, namespace and subdomain routes preserve HEAD and replace Docker credentials', async t => {
	mockFetch(t, request => {
		const url = new URL(request.url);
		assert.equal(url.hostname, 'ghcr.io');
		if (url.pathname === '/token') {
			assert.equal(request.headers.get('Authorization'), null);
			assert.equal(request.headers.get('Cookie'), null);
			return Response.json({ token: 'github-token' });
		}
		assert.equal(url.pathname, `/v2/${repo}/manifests/latest`);
		assert.equal(url.search, '');
		assert.equal(request.method, 'HEAD');
		assert.equal(request.headers.get('Authorization'), 'Bearer github-token');
		return new Response(null, { headers: { 'Docker-Content-Digest': digest } });
	});
	for (const path of [
		`/v2/ghcr.io/${repo}/manifests/latest`,
		`/v2/${repo}/manifests/latest?ns=ghcr.io`,
		`/v2/${repo}/manifests/latest?hubhost=ghcr.example.com`,
		`https://ghcr.example.com/v2/${repo}/manifests/latest`,
	]) {
		const response = await invoke(path, { method: 'HEAD', headers: { Authorization: 'Bearer docker-token', Cookie: 'private=secret' } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Docker-Content-Digest'), digest);
		assert.equal(await response.text(), '');
	}
});

test('blob redirects stream ranges without sending credentials to the CDN', async t => {
	mockFetch(t, request => {
		const url = new URL(request.url);
		if (url.pathname === '/token') return Response.json({ token: 'github-token' });
		if (url.hostname === 'ghcr.io') {
			assert.equal(request.headers.get('Authorization'), 'Bearer github-token');
			return new Response(null, { status: 307, headers: { Location: 'https://pkg-containers.githubusercontent.com/blob?sig=example' } });
		}
		assert.equal(url.hostname, 'pkg-containers.githubusercontent.com');
		assert.equal(request.headers.get('Authorization'), null);
		assert.equal(request.headers.get('Cookie'), null);
		assert.equal(request.headers.get('Range'), 'bytes=0-2');
		return new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 0-2/10' } });
	});
	const response = await invoke(`/v2/ghcr.io/${repo}/blobs/${digest}`, { headers: { Range: 'bytes=0-2', Cookie: 'secret=1' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('Content-Range'), 'bytes 0-2/10');
	assert.equal(await response.text(), 'abc');
});

test('invalid input and writes are rejected before any upstream requests', async t => {
	mockFetch(t, () => { assert.fail('unexpected upstream request'); });
	for (const q of ['ghcr.io', 'ghcr.io/owner', 'ghcr.io/owner/repo?url=https://evil.test', 'ghcr.io/owner/repo:bad;tag']) {
		assert.equal((await invoke(`/v1/search?q=${encodeURIComponent(q)}`)).status, 400);
	}
	assert.equal((await invoke(`/v2/ghcr.io/${repo}/manifests/latest`, { method: 'PUT' })).status, 405);
	assert.equal((await invoke('/v2/ghcr.io/bad/manifests/latest')).status, 400);
});

test('untrusted redirects are blocked and GHCR failures remain errors', async t => {
	let mode = 'redirect';
	let calls = 0;
	mockFetch(t, request => {
		calls++;
		if (new URL(request.url).pathname === '/token') {
			if (mode === 'denied') return Response.json({ error: 'denied' }, { status: 403 });
			if (mode === 'network') throw new Error('upstream down');
			return Response.json({ token: 'github-token' });
		}
		if (mode === 'missing') return Response.json({ errors: [] }, { status: 404 });
		return new Response(null, { status: 307, headers: { Location: 'https://evil.test/blob' } });
	});
	assert.equal((await invoke(`/v2/ghcr.io/${repo}/blobs/${digest}`)).status, 502);
	assert.equal(calls, 2);
	for (const [nextMode, status] of [['denied', 403], ['missing', 404], ['network', 502]]) {
		mode = nextMode;
		const response = await invoke(`/v1/search?q=ghcr.io/${repo}:latest`);
		assert.equal(response.status, status);
		assert.match((await response.json()).error, /GHCR/);
	}
});

test('Docker Hub search and subsequent requests retain the Docker upstream', async t => {
	const calls = [];
	mockFetch(t, request => {
		calls.push(new URL(request.url));
		return Response.json({ results: [], token: 'docker-token' });
	});
	await invoke('/v2/?ns=quay.io');
	await invoke('/v2/');
	await invoke('/v1/search?q=nginx');
	assert.deepEqual(calls.map(url => url.hostname), ['quay.io', 'registry-1.docker.io', 'index.docker.io']);
});

test('Docker Hub library paths still work and supplied registry auth is preserved', async t => {
	const calls = [];
	mockFetch(t, request => {
		const url = new URL(request.url);
		calls.push(url);
		if (url.hostname === 'auth.docker.io') return Response.json({ token: 'docker-token' });
		assert.equal(url.pathname, '/v2/library/nginx/manifests/latest');
		assert.equal(request.headers.get('Authorization'), calls.length === 3 ? 'Bearer supplied' : 'Bearer docker-token');
		return Response.json({ schemaVersion: 2 });
	});
	await invoke('/v2/nginx/manifests/latest');
	await invoke('/v2/library/nginx/manifests/latest', { headers: { Authorization: 'Bearer supplied' } });
	assert.deepEqual(calls.map(url => url.hostname), ['auth.docker.io', 'registry-1.docker.io', 'registry-1.docker.io']);
});

test('generated page scripts execute and display GHCR pull commands without fake Hub statistics', async () => {
	const html = await (await invoke('/search?q=ghcr.io/' + repo, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
	const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
	const elements = new Map();
	const element = id => {
		if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {}, querySelectorAll() { return []; } });
		return elements.get(id);
	};
	const context = vm.createContext({
		URLSearchParams, location: { search: '?q=ghcr.io/' + repo, host: 'docker.example.com' },
		document: { getElementById: element },
		fetch: async url => {
			assert.match(url, /^\/v1\/search\?q=ghcr.io/);
			return Response.json({ registry: 'ghcr.io', next_last: 'v1', results: [{ name: `ghcr.io/${repo}:latest`, description: '公开镜像' }] });
		},
	});
	new vm.Script(script).runInContext(context);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.match(element('results').innerHTML, /docker pull docker.example.com\/ghcr.io\/veildawn\/ai-proxy-release:latest/);
	assert.doesNotMatch(element('results').innerHTML, /⭐/);
	assert.equal(element('next-btn').disabled, false);
	assert.equal(element('prev-btn').disabled, true);
	element('next-btn').onclick();
	assert.match(context.location.href, /last=v1/);
	const home = await (await invoke('/', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
	new vm.Script(home.match(/<script>([\s\S]*?)<\/script>/)[1]);
	assert.match(home, /GHCR/);
});
