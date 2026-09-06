import worker from './worker.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export default {
  async test() {
    const response = await worker.fetch(new Request('https://docker.example.com/v1/search?q=ghcr.io/owner/image'), {}, {});
    const body = await response.json();
    assert(response.status === 200, `workerd GHCR search failed: ${response.status} ${JSON.stringify(body)}`);
    assert(body.results[0].name === 'ghcr.io/owner/image:latest', 'incorrect pull name');

    const redirect = await worker.fetch(new Request('https://docker.example.com/v1/search?q=ghcr.io/owner/redirect'), {}, {});
    assert(redirect.status === 502, 'token redirects must fail safely with 502');
    assert((await redirect.json()).error.includes('重定向'), 'specific failure should reach the search page');
  }
};

// Deterministic upstream: the actual workerd Request/fetch implementation is used.
export const upstream = {
  async fetch(request) {
    const url = new URL(request.url);
    assert(url.hostname === 'ghcr.io', 'must not follow token redirects');
    if (url.pathname === '/token') {
      assert(!request.headers.has('Authorization'), 'client credentials must not reach token service');
      if (url.searchParams.get('scope') === 'repository:owner/redirect:pull') {
        return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/token' } });
      }
      return Response.json({ token: 'test-token' });
    }
    assert(request.headers.get('Authorization') === 'Bearer test-token', 'missing GHCR token');
    assert(url.pathname === '/v2/owner/image/tags/list', 'incorrect registry path');
    return Response.json({ tags: ['latest'] });
  }
};
