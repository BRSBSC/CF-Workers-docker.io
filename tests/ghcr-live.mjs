// Optional live integration check: node tests/ghcr-live.mjs
// Reads public GHCR data only; does not publish or run containers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => nativeFetch(input, { ...init, signal: AbortSignal.timeout(25000) });
const repo = 'veildawn/ai-proxy-release';
const invoke = (path, init) => worker.fetch(new Request(`https://docker.example.com${path}`, init), {}, {});
const check = async (path, init) => {
	const response = await invoke(path, init);
	assert.equal(response.status, 200, `${path}: ${response.status} ${response.status === 200 ? '' : await response.text()}`);
	return response;
};

const tags = await (await check(`/v1/search?q=ghcr.io/${repo}`)).json();
assert.ok(tags.results.length > 0);
assert.ok(tags.results.every(result => result.name.startsWith(`ghcr.io/${repo}:`)));
console.log(`PASS public tag lookup: ${tags.results.length} tags on first page`);
if (tags.next_last) {
	const next = await (await check(`/v1/search?q=ghcr.io/${repo}&last=${encodeURIComponent(tags.next_last)}`)).json();
	assert.ok(next.results.length > 0);
	assert.notEqual(next.results[0].name, tags.results[0].name);
	console.log('PASS live tag pagination');
}

await check(`/v1/search?q=ghcr.io/${repo}:latest`);
const index = await (await check(`/v2/ghcr.io/${repo}/manifests/latest`)).json();
const descriptor = index.manifests.find(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64');
assert.ok(descriptor);
const manifestResponse = await check(`/v2/ghcr.io/${repo}/manifests/${descriptor.digest}`);
const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
assert.equal(`sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`, descriptor.digest);
const manifest = JSON.parse(manifestBytes);
console.log('PASS latest OCI index and linux/amd64 manifest with digest verification');

const head = await check(`/v2/ghcr.io/${repo}/manifests/latest`, { method: 'HEAD' });
assert.equal(await head.text(), '');
assert.ok(head.headers.get('Docker-Content-Digest'));
console.log('PASS manifest HEAD and digest header');

const config = Buffer.from(await (await check(`/v2/ghcr.io/${repo}/blobs/${manifest.config.digest}`)).arrayBuffer());
assert.equal(`sha256:${createHash('sha256').update(config).digest('hex')}`, manifest.config.digest);
console.log(`PASS config blob download through CDN, SHA-256 verified (${config.length} bytes)`);

const smallLayer = manifest.layers.find(layer => layer.size > 0 && layer.size < 1024 * 1024);
if (smallLayer) {
	const bytes = Buffer.from(await (await check(`/v2/ghcr.io/${repo}/blobs/${smallLayer.digest}`)).arrayBuffer());
	assert.equal(bytes.length, smallLayer.size);
	assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, smallLayer.digest);
	console.log(`PASS image layer download, size and SHA-256 verified (${bytes.length} bytes)`);
}

const range = await invoke(`/v2/ghcr.io/${repo}/blobs/${manifest.layers[0].digest}`, { headers: { Range: 'bytes=0-1023' } });
try {
	assert.equal(range.status, 206);
	assert.match(range.headers.get('Content-Range'), /^bytes 0-1023\//);
	assert.equal((await range.arrayBuffer()).byteLength, 1024);
} finally {
	if (!range.bodyUsed) await range.body?.cancel();
}
console.log('PASS layer range download (1024 bytes)');

await check(`/v2/${repo}/manifests/latest?ns=ghcr.io`, { method: 'HEAD' });
console.log('PASS containerd namespace route');
