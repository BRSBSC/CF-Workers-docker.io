// _worker.js

// Docker镜像仓库主机地址
const hub_host = 'registry-1.docker.io';
// Docker认证服务器地址
const auth_url = 'https://auth.docker.io';

// 路由表：子域名前缀 → 上游地址；ns 参数也只接受这里的上游
const ROUTES = {
	// 生产环境
	"quay": "quay.io",
	"gcr": "gcr.io",
	"k8s-gcr": "k8s.gcr.io",
	"k8s": "registry.k8s.io",
	"ghcr": "ghcr.io",
	"cloudsmith": "docker.cloudsmith.io",
	"nvcr": "nvcr.io",

	// 测试环境
	"test": "registry-1.docker.io",
};

// 根据主机名选择对应的上游地址
function routeByHosts(host) {
	if (Object.hasOwn(ROUTES, host)) return [ROUTES[host], false];
	else return [hub_host, true];
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

const GHCR_REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/;
const GHCR_REFERENCE = /^(?:[\w][\w.-]{0,127}|sha256:[a-f0-9]{64})$/;
const MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

// GHCR 匿名公开读令牌，同一 isolate 内按仓库复用
const ghcrTokens = new Map();

function ghcrError(message, status) {
	return Response.json({ error: message }, { status });
}

// Public, read-only GHCR access. Never forward Docker Hub credentials to GitHub.
async function fetchGhcr(request, url) {
	if (!['GET', 'HEAD'].includes(request.method)) {
		return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
	}
	if (url.pathname === '/v2/' || url.pathname === '/v2') {
		return new Response(request.method === 'HEAD' ? null : '{}', {
			headers: { 'Docker-Distribution-Api-Version': 'registry/2.0', 'Content-Type': 'application/json' },
		});
	}
	const match = url.pathname.match(/^\/v2\/(.+)\/(manifests\/([^/]+)|blobs\/(sha256:[a-f0-9]{64})|tags\/list)$/);
	if (!match || match[1].length > 255 || !GHCR_REPOSITORY.test(match[1]) || (match[3] && !GHCR_REFERENCE.test(match[3]))) {
		return ghcrError('无效的 GHCR 镜像路径', 400);
	}
	try {
		let cached = ghcrTokens.get(match[1]);
		if (!cached || cached.expires <= Date.now()) {
			const tokenUrl = new URL('https://ghcr.io/token');
			tokenUrl.search = new URLSearchParams({ service: 'ghcr.io', scope: `repository:${match[1]}:pull` });
			// workerd rejects redirect: 'error'; inspect redirects without following them.
			const tokenResponse = await fetch(tokenUrl, { redirect: 'manual' });
			if (tokenResponse.status >= 300 && tokenResponse.status < 400) {
				await tokenResponse.body?.cancel();
				return ghcrError('GHCR 认证服务返回了意外重定向，请稍后重试', 502);
			}
			if (!tokenResponse.ok) {
				await tokenResponse.body?.cancel();
				return ghcrError([401, 403, 404].includes(tokenResponse.status)
					? '无法访问该 GHCR 镜像，请确认地址正确且镜像为公开可读'
					: `GHCR 认证服务暂时不可用（HTTP ${tokenResponse.status}），请稍后重试`, tokenResponse.status);
			}
			const tokenData = await tokenResponse.json();
			const token = tokenData.token || tokenData.access_token;
			if (typeof token !== 'string' || !token) return ghcrError('GHCR 未返回有效令牌', 502);
			if (ghcrTokens.size >= 1000) ghcrTokens.clear();
			// 在有效期的 90% 内复用；令牌规范规定没给 expires_in 时有效期为 60 秒
			cached = { token, expires: Date.now() + (Number(tokenData.expires_in) || 60) * 900 };
			ghcrTokens.set(match[1], cached);
		}
		const headers = new Headers({ Authorization: `Bearer ${cached.token}` });
		for (const key of ['Accept', 'Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
			if (request.headers.has(key)) headers.set(key, request.headers.get(key));
		}
		if (!headers.has('Accept') || headers.get('Accept') === '*/*') headers.set('Accept', MANIFEST_ACCEPT);
		let upstream = new URL(url.pathname, 'https://ghcr.io');
		for (const key of ['n', 'last']) {
			if (url.searchParams.has(key)) upstream.searchParams.set(key, url.searchParams.get(key));
		}
		for (let redirects = 0; redirects <= 3; redirects++) {
			const response = await fetch(upstream, { method: request.method, headers, redirect: 'manual' });
			if (response.status === 401) ghcrTokens.delete(match[1]); // 令牌提前失效时，下个请求重新获取
			if (![301, 302, 303, 307, 308].includes(response.status)) return response;
			const location = response.headers.get('Location');
			await response.body?.cancel();
			if (!location) return ghcrError('GHCR 返回了无效重定向', 502);
			const target = new URL(location, upstream);
			if (target.protocol !== 'https:' || target.port || target.username || target.password ||
				!['ghcr.io', 'pkg-containers.githubusercontent.com'].includes(target.hostname)) {
				return ghcrError('GHCR 返回了不支持的下载地址', 502);
			}
			if (target.origin !== upstream.origin) headers.delete('Authorization');
			upstream = target;
		}
		return ghcrError('GHCR 重定向次数过多', 502);
	} catch {
		return ghcrError('GHCR 请求失败，请稍后重试', 502);
	}
}

async function searchGhcr(url) {
	const query = (url.searchParams.get('q') || '').trim().replace(/^https:\/\//i, '');
	const match = query.match(/^ghcr\.io\/([^:@]+)(?::([\w][\w.-]{0,127})|@(sha256:[a-f0-9]{64}))?$/i);
	if (!match || match[1].length > 255 || !GHCR_REPOSITORY.test(match[1])) {
		return ghcrError('请输入完整地址：ghcr.io/所有者/镜像名，可附加 :标签 或 @sha256:摘要', 400);
	}
	const repo = match[1];
	const reference = match[2] || match[3];
	const upstream = new URL(`/v2/${repo}/${reference ? `manifests/${reference}` : 'tags/list'}`, 'https://ghcr.io');
	if (!reference) {
		upstream.searchParams.set('n', '25');
		const last = url.searchParams.get('last');
		if (last && !/^[\w][\w.-]{0,127}$/.test(last)) return ghcrError('无效的标签分页参数', 400);
		if (last) upstream.searchParams.set('last', last);
	}
	const response = await fetchGhcr(new Request(upstream), upstream);
	if (!response.ok) {
		const failure = await response.json().catch(() => null);
		const message = typeof failure?.error === 'string' ? failure.error :
			([401, 403, 404].includes(response.status)
				? `GHCR 查询失败（${response.status}），请确认镜像或标签存在且为公开可读`
				: `GHCR 服务暂时不可用（HTTP ${response.status}），请稍后重试`);
		return ghcrError(message, response.status);
	}
	let tags;
	let nextLast = null;
	if (reference) {
		await response.body?.cancel();
		tags = [reference];
	} else {
		const data = await response.json().catch(() => null);
		if (!data || (data.tags != null && (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string' || !/^[\w][\w.-]{0,127}$/.test(tag))))) {
			return ghcrError('GHCR 返回了无效的标签列表', 502);
		}
		tags = data.tags || [];
		const next = response.headers.get('Link')?.match(/<([^>]+)>;\s*rel="?next"?/);
		if (next) nextLast = new URL(next[1], upstream).searchParams.get('last');
	}
	return Response.json({
		registry: 'ghcr.io', next_last: nextLast,
		results: tags.map(tag => ({
			name: `ghcr.io/${repo}${tag.startsWith('sha256:') ? '@' : ':'}${tag}`,
			description: `GHCR 公开镜像 · ${tag.startsWith('sha256:') ? '摘要' : '标签'}：${tag}`,
		})),
	});
}

async function searchInterface() {
	const html = `
	<!DOCTYPE html>
	<html>
	<head>
		<title>Docker Hub / GHCR 镜像查询</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
		:root {
			--github-color: rgb(27,86,198);
			--github-bg-color: #ffffff;
			--primary-color: #0066ff;
			--primary-dark: #0052cc;
			--gradient-start: #1a90ff;
			--gradient-end: #003eb3;
			--text-color: #ffffff;
			--shadow-color: rgba(0,0,0,0.1);
			--transition-time: 0.3s;
		}
		
		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			display: flex;
			flex-direction: column;
			justify-content: center;
			align-items: center;
			min-height: 100vh;
			margin: 0;
			background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
			padding: 20px;
			color: var(--text-color);
			overflow-x: hidden;
		}

		.container {
			text-align: center;
			width: 100%;
			max-width: 800px;
			padding: 20px;
			margin: 0 auto;
			display: flex;
			flex-direction: column;
			justify-content: center;
			min-height: 60vh;
			animation: fadeIn 0.8s ease-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(20px); }
			to { opacity: 1; transform: translateY(0); }
		}

		.github-corner {
			position: fixed;
			top: 0;
			right: 0;
			z-index: 999;
			transition: transform var(--transition-time) ease;
		}
		
		.github-corner:hover {
			transform: scale(1.08);
		}

		.github-corner svg {
			fill: var(--github-bg-color);
			color: var(--github-color);
			position: absolute;
			top: 0;
			border: 0;
			right: 0;
			width: 80px;
			height: 80px;
			filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.2));
		}

		.logo {
			margin-bottom: 20px;
			transition: transform var(--transition-time) ease;
			animation: float 6s ease-in-out infinite;
		}
		
		@keyframes float {
			0%, 100% { transform: translateY(0); }
			50% { transform: translateY(-10px); }
		}
		
		.logo:hover {
			transform: scale(1.08) rotate(5deg);
		}
		
		.logo svg {
			filter: drop-shadow(0 5px 15px rgba(0, 0, 0, 0.2));
		}
		
		.title {
			color: var(--text-color);
			font-size: 2.3em;
			margin-bottom: 10px;
			text-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
			font-weight: 700;
			letter-spacing: -0.5px;
			animation: slideInFromTop 0.5s ease-out 0.2s both;
		}
		
		@keyframes slideInFromTop {
			from { opacity: 0; transform: translateY(-20px); }
			to { opacity: 1; transform: translateY(0); }
		}
		
		.subtitle {
			color: rgba(255, 255, 255, 0.9);
			font-size: 1.1em;
			margin-bottom: 25px;
			max-width: 600px;
			margin-left: auto;
			margin-right: auto;
			line-height: 1.4;
			animation: slideInFromTop 0.5s ease-out 0.4s both;
		}
		
		.search-container {
			display: flex;
			align-items: stretch;
			width: 100%;
			max-width: 600px;
			margin: 0 auto;
			height: 55px;
			position: relative;
			animation: slideInFromBottom 0.5s ease-out 0.6s both;
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
			border-radius: 12px;
			overflow: hidden;
		}
		
		@keyframes slideInFromBottom {
			from { opacity: 0; transform: translateY(20px); }
			to { opacity: 1; transform: translateY(0); }
		}
		
		#search-input {
			flex: 1;
			padding: 0 20px;
			font-size: 16px;
			border: none;
			outline: none;
			transition: all var(--transition-time) ease;
			height: 100%;
		}
		
		#search-input:focus {
			padding-left: 25px;
		}
		
		#search-button {
			width: 60px;
			background-color: var(--primary-color);
			border: none;
			cursor: pointer;
			transition: all var(--transition-time) ease;
			height: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			position: relative;
		}
		
		#search-button svg {
			transition: transform 0.3s ease;
			stroke: white;
		}
		
		#search-button:hover {
			background-color: var(--primary-dark);
		}
		
		#search-button:hover svg {
			transform: translateX(2px);
		}
		
		#search-button:active svg {
			transform: translateX(4px);
		}
		
		.tips {
			color: rgba(255, 255, 255, 0.8);
			margin-top: 20px;
			font-size: 0.9em;
			animation: fadeIn 0.5s ease-out 0.8s both;
			transition: transform var(--transition-time) ease;
		}
		
		.tips:hover {
			transform: translateY(-2px);
		}
		
		@media (max-width: 768px) {
			.container {
				padding: 20px 15px;
				min-height: 60vh;
			}
			
			.title {
				font-size: 2em;
			}
			
			.subtitle {
				font-size: 1em;
				margin-bottom: 20px;
			}
			
			.search-container {
				height: 50px;
			}
		}
		
		@media (max-width: 480px) {
			.container {
				padding: 15px 10px;
				min-height: 60vh;
			}
			
			.github-corner svg {
				width: 60px;
				height: 60px;
			}
			
			.search-container {
				height: 45px;
			}
			
			#search-input {
				padding: 0 15px;
			}
			
			#search-button {
				width: 50px;
			}
			
			#search-button svg {
				width: 18px;
				height: 18px;
			}
			
			.title {
				font-size: 1.7em;
				margin-bottom: 8px;
			}
			
			.subtitle {
				font-size: 0.95em;
				margin-bottom: 18px;
			}
		}
		</style>
	</head>
	<body>
		<a href="https://github.com/cmliu/CF-Workers-docker.io" target="_blank" class="github-corner" aria-label="View source on Github">
			<svg viewBox="0 0 250 250" aria-hidden="true">
				<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
				<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
				<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
			</svg>
		</a>
		<div class="container">
			<div class="logo">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" fill="#ffffff" width="110" height="85">
					<path d="M23.763 6.886c-.065-.053-.673-.512-1.954-.512-.32 0-.659.03-1.01.087-.248-1.703-1.651-2.533-1.716-2.57l-.345-.2-.227.328a4.596 4.596 0 0 0-.611 1.433c-.23.972-.09 1.884.403 2.666-.596.331-1.546.418-1.744.42H.752a.753.753 0 0 0-.75.749c-.007 1.456.233 2.864.692 4.07.545 1.43 1.355 2.483 2.409 3.13 1.181.725 3.104 1.14 5.276 1.14 1.016 0 2.03-.092 2.93-.266 1.417-.273 2.705-.742 3.826-1.391a10.497 10.497 0 0 0 2.61-2.14c1.252-1.42 1.998-3.005 2.553-4.408.075.003.148.005.221.005 1.371 0 2.215-.55 2.68-1.01.505-.5.685-.998.704-1.053L24 7.076l-.237-.19Z"></path>
					<path d="M2.216 8.075h2.119a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H2.216A.186.186 0 0 0 2.031 6v1.89c0 .103.083.186.185.186Zm2.92 0h2.118a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186H5.136A.185.185 0 0 0 4.95 6v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H8.1A.185.185 0 0 0 7.914 6v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm-5.892-2.72h2.118a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H8.1a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm0-2.72h2.119a.186.186 0 0 0 .185-.186V.56a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm2.955 5.44h2.118a.185.185 0 0 0 .186-.186V6a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.186v1.89c0 .103.083.186.185.186Z"></path>
				</svg>
			</div>
			<h1 class="title">Docker Hub / GHCR 镜像查询</h1>
			<p class="subtitle">关键词搜索 Docker Hub，完整 ghcr.io 地址查询公开镜像标签</p>
			<div class="search-container">
				<input type="text" id="search-input" placeholder="nginx 或 ghcr.io/owner/image">
				<button id="search-button" title="搜索">
					<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
						<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"></path>
					</svg>
				</button>
			</div>
			<p class="tips">基于 Cloudflare Workers / Pages 构建，利用全球边缘网络实现毫秒级响应。</p>
		</div>
		<script>
		function performSearch() {
			const query = document.getElementById('search-input').value;
			if (query) {
				window.location.href = '/search?q=' + encodeURIComponent(query);
			}
		}
	
		document.getElementById('search-button').addEventListener('click', performSearch);
		document.getElementById('search-input').addEventListener('keypress', function(event) {
			if (event.key === 'Enter') {
				performSearch();
			}
		});

		// 添加焦点在搜索框
		window.addEventListener('load', function() {
			document.getElementById('search-input').focus();
		});
		</script>
	</body>
	</html>
	`;
	return html;
}

async function searchResultsPage() {
	const html = `
	<!DOCTYPE html>
	<html>
	<head>
		<title>镜像查询结果 - Docker Hub / GHCR</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
		:root {
			--primary-color: #0066ff;
			--primary-dark: #0052cc;
			--gradient-start: #1a90ff;
			--gradient-end: #003eb3;
			--text-color: #ffffff;
			--transition-time: 0.3s;
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			min-height: 100vh;
			background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
			padding: 20px;
			color: var(--text-color);
		}

		.container {
			width: 100%;
			max-width: 800px;
			margin: 0 auto;
		}

		.header {
			display: flex;
			align-items: center;
			gap: 15px;
			margin-bottom: 25px;
		}

		.header .logo-link {
			display: flex;
			align-items: center;
			flex-shrink: 0;
		}

		.search-container {
			display: flex;
			align-items: stretch;
			flex: 1;
			height: 45px;
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
			border-radius: 12px;
			overflow: hidden;
		}

		#search-input {
			flex: 1;
			padding: 0 20px;
			font-size: 16px;
			border: none;
			outline: none;
			height: 100%;
			min-width: 0;
		}

		#search-button {
			width: 55px;
			background-color: var(--primary-color);
			border: none;
			cursor: pointer;
			height: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: background-color var(--transition-time) ease;
		}

		#search-button:hover {
			background-color: var(--primary-dark);
		}

		#status {
			text-align: center;
			margin: 30px 0;
			font-size: 1.05em;
			color: rgba(255, 255, 255, 0.9);
		}

		.result-card {
			background: rgba(255, 255, 255, 0.96);
			color: #333;
			border-radius: 12px;
			padding: 16px 20px;
			margin-bottom: 14px;
			box-shadow: 0 4px 15px rgba(0, 0, 0, 0.12);
			animation: fadeIn 0.4s ease-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(10px); }
			to { opacity: 1; transform: translateY(0); }
		}

		.result-title {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: wrap;
		}

		.result-name {
			font-size: 1.15em;
			font-weight: 700;
			color: var(--primary-dark);
			word-break: break-all;
		}

		.badge {
			background: var(--primary-color);
			color: #fff;
			font-size: 0.72em;
			padding: 2px 8px;
			border-radius: 10px;
			white-space: nowrap;
		}

		.result-desc {
			margin: 8px 0;
			font-size: 0.92em;
			color: #555;
			line-height: 1.45;
			word-break: break-word;
		}

		.result-meta {
			font-size: 0.85em;
			color: #888;
			margin-bottom: 10px;
		}

		.pull-cmd {
			display: flex;
			align-items: center;
			gap: 8px;
			background: #f0f4fa;
			border: 1px solid #dbe4f0;
			border-radius: 8px;
			padding: 8px 12px;
			font-family: Consolas, Monaco, "Courier New", monospace;
			font-size: 0.85em;
			color: #1a3c6e;
			cursor: pointer;
			transition: background var(--transition-time) ease;
			overflow-x: auto;
			white-space: nowrap;
		}

		.pull-cmd:hover {
			background: #e2ebf7;
		}

		.pull-cmd .copy-hint {
			margin-left: auto;
			color: #8aa4c4;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			flex-shrink: 0;
		}

		.pager {
			display: flex;
			justify-content: center;
			align-items: center;
			gap: 15px;
			margin: 25px 0 10px;
		}

		.pager button {
			background: rgba(255, 255, 255, 0.95);
			color: var(--primary-dark);
			border: none;
			border-radius: 8px;
			padding: 9px 22px;
			font-size: 0.95em;
			font-weight: 600;
			cursor: pointer;
			transition: transform var(--transition-time) ease;
		}

		.pager button:hover {
			transform: translateY(-2px);
		}

		.pager button:disabled {
			opacity: 0.45;
			cursor: not-allowed;
			transform: none;
		}

		@media (max-width: 480px) {
			body {
				padding: 12px;
			}

			.header {
				gap: 10px;
				margin-bottom: 18px;
			}

			.search-container {
				height: 42px;
			}

			#search-input {
				padding: 0 14px;
				font-size: 15px;
			}

			#search-button {
				width: 48px;
			}
		}
		</style>
	</head>
	<body>
		<div class="container">
			<div class="header">
				<a href="/" class="logo-link" title="返回首页">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" fill="#ffffff" width="52" height="40">
						<path d="M23.763 6.886c-.065-.053-.673-.512-1.954-.512-.32 0-.659.03-1.01.087-.248-1.703-1.651-2.533-1.716-2.57l-.345-.2-.227.328a4.596 4.596 0 0 0-.611 1.433c-.23.972-.09 1.884.403 2.666-.596.331-1.546.418-1.744.42H.752a.753.753 0 0 0-.75.749c-.007 1.456.233 2.864.692 4.07.545 1.43 1.355 2.483 2.409 3.13 1.181.725 3.104 1.14 5.276 1.14 1.016 0 2.03-.092 2.93-.266 1.417-.273 2.705-.742 3.826-1.391a10.497 10.497 0 0 0 2.61-2.14c1.252-1.42 1.998-3.005 2.553-4.408.075.003.148.005.221.005 1.371 0 2.215-.55 2.68-1.01.505-.5.685-.998.704-1.053L24 7.076l-.237-.19Z"></path>
					</svg>
				</a>
				<div class="search-container">
					<input type="text" id="search-input" placeholder="Docker Hub 关键词或完整 ghcr.io 镜像地址">
					<button id="search-button" title="搜索">
						<svg width="18" height="18" fill="none" stroke="#ffffff" stroke-width="2" viewBox="0 0 24 24">
							<circle cx="11" cy="11" r="7"></circle>
							<path d="M21 21l-4.35-4.35" stroke-linecap="round"></path>
						</svg>
					</button>
				</div>
			</div>
			<div id="status">正在搜索...</div>
			<div id="results"></div>
			<div class="pager" id="pager" style="display:none">
				<button id="prev-btn">上一页</button>
				<button id="next-btn">下一页</button>
			</div>
		</div>
		<script>
		(function() {
			var params = new URLSearchParams(location.search);
			var query = params.get('q') || '';
			var page = parseInt(params.get('page') || '1', 10);
			if (isNaN(page) || page < 1) page = 1;
			var pageSize = 25;
			var statusEl = document.getElementById('status');
			var resultsEl = document.getElementById('results');
			var pagerEl = document.getElementById('pager');
			var prevBtn = document.getElementById('prev-btn');
			var nextBtn = document.getElementById('next-btn');
			var input = document.getElementById('search-input');
			input.value = query;

			function goSearch(q, p, last) {
				location.href = '/search?q=' + encodeURIComponent(q) + (p > 1 ? '&page=' + p : '') + (last ? '&last=' + encodeURIComponent(last) : '');
			}

			document.getElementById('search-button').addEventListener('click', function() {
				if (input.value.trim()) goSearch(input.value.trim(), 1);
			});
			input.addEventListener('keypress', function(e) {
				if (e.key === 'Enter' && input.value.trim()) goSearch(input.value.trim(), 1);
			});

			function escapeHtml(s) {
				return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
					return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
				});
			}

			function formatCount(n) {
				if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
				if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
				if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
				return String(n);
			}

			function render(data) {
				var results = data.results || [];
				if (results.length === 0) {
					statusEl.textContent = data.registry ? '该 GHCR 镜像没有可显示的标签' : '未找到与 "' + query + '" 相关的镜像';
					return;
				}
				statusEl.textContent = data.registry ? 'GHCR 精确查询 · 本页 ' + results.length + ' 个标签 / 摘要' : '共 ' + data.num_results + ' 个结果，第 ' + data.page + ' / ' + data.num_pages + ' 页';
				var html = '';
				for (var i = 0; i < results.length; i++) {
					var r = results[i];
					var name = escapeHtml(r.name);
					var cmd = 'docker pull ' + location.host + '/' + r.name;
					html += '<div class="result-card">'
						+ '<div class="result-title"><span class="result-name">' + name + '</span>'
						+ (r.is_official ? '<span class="badge">官方镜像</span>' : '')
						+ '</div>'
						+ (r.description ? '<div class="result-desc">' + escapeHtml(r.description) + '</div>' : '')
						+ (data.registry ? '' : '<div class="result-meta">⭐ ' + formatCount(r.star_count || 0) + ' &nbsp;&nbsp; ⬇️ ' + formatCount(r.pull_count || 0) + '</div>')
						+ '<div class="pull-cmd" data-cmd="' + escapeHtml(cmd) + '" title="点击复制"><span>' + escapeHtml(cmd) + '</span><span class="copy-hint">点击复制</span></div>'
						+ '</div>';
				}
				resultsEl.innerHTML = html;
				var cmds = resultsEl.querySelectorAll('.pull-cmd');
				for (var j = 0; j < cmds.length; j++) {
					cmds[j].addEventListener('click', function() {
						var el = this;
						var text = el.getAttribute('data-cmd');
						function done() {
							var hint = el.querySelector('.copy-hint');
							hint.textContent = '已复制 ✓';
							setTimeout(function() { hint.textContent = '点击复制'; }, 2000);
						}
						if (navigator.clipboard && navigator.clipboard.writeText) {
							navigator.clipboard.writeText(text).then(done);
						} else {
							var ta = document.createElement('textarea');
							ta.value = text;
							document.body.appendChild(ta);
							ta.select();
							document.execCommand('copy');
							document.body.removeChild(ta);
							done();
						}
					});
				}
				pagerEl.style.display = 'flex';
				prevBtn.disabled = data.registry ? !params.get('last') : page <= 1;
				prevBtn.textContent = data.registry ? '返回首页标签' : '上一页';
				nextBtn.disabled = data.registry ? !data.next_last : page >= data.num_pages;
				prevBtn.onclick = function() { goSearch(query, data.registry ? 1 : page - 1); };
				nextBtn.onclick = function() { goSearch(query, page + 1, data.next_last); };
			}

			if (!query) {
				statusEl.textContent = '请输入关键词进行搜索';
				return;
			}

			fetch('/v1/search?q=' + encodeURIComponent(query) + '&n=' + pageSize + '&page=' + page + '&last=' + encodeURIComponent(params.get('last') || ''))
				.then(function(res) {
					if (!res.ok) return res.json().catch(function() { return {}; }).then(function(data) { throw new Error(data.error || 'HTTP ' + res.status); });
					return res.json();
				})
				.then(render)
				.catch(function(err) {
					statusEl.textContent = '搜索失败：' + err.message + '，请稍后重试';
				});
		})();
		</script>
	</body>
	</html>
	`;
	return html;
}

export default {
	async fetch(request, env, ctx) {
		// 只复制客户端实际带了的请求头；缺失的头照抄会变成字符串 "null"
		const pickHeaders = (...keys) => {
			const headers = new Headers();
			for (const key of keys) if (request.headers.has(key)) headers.set(key, request.headers.get(key));
			return headers;
		};

		let url = new URL(request.url); // 解析请求URL
		// Keep registry selection request-local so GHCR cannot affect later Docker Hub requests.
		let hub_host = 'registry-1.docker.io';
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const 屏蔽爬虫UA = ['netcraft', ...(env.UA ? await ADD(env.UA.toLowerCase()) : [])].filter(Boolean);
		const workers_url = `https://${url.hostname}`;

		// 获取请求参数中的 ns
		const ns = url.searchParams.get('ns');
		const hostname = url.searchParams.get('hubhost') || url.hostname;
		const hostTop = hostname.split('.')[0]; // 获取主机名的第一部分
		if (url.pathname === '/v1/search' && /^(?:https:\/\/)?ghcr\.io(?:\/|$)/i.test((url.searchParams.get('q') || '').trim())) {
			return searchGhcr(url);
		}
		if (url.pathname.startsWith('/v2/ghcr.io/')) {
			url.pathname = url.pathname.replace('/v2/ghcr.io/', '/v2/');
			return fetchGhcr(request, url);
		}
		if ((ns === 'ghcr.io' || (!ns && hostTop === 'ghcr')) && (url.pathname === '/v2' || url.pathname.startsWith('/v2/'))) {
			return fetchGhcr(request, url);
		}

		let checkHost; // 在这里定义 checkHost 变量
		// 如果存在 ns 参数，优先使用它来确定 hub_host
		if (ns) {
			if (ns === 'docker.io') {
				hub_host = 'registry-1.docker.io'; // 设置上游地址为 registry-1.docker.io
			} else if (Object.values(ROUTES).includes(ns)) {
				hub_host = ns;
			} else {
				// 任意 ns 会让 Worker 变成开放代理
				return new Response('不支持的 ns 参数', { status: 400 });
			}
		} else {
			checkHost = routeByHosts(hostTop);
			hub_host = checkHost[0]; // 获取上游地址
		}

		const fakePage = checkHost ? checkHost[1] : false; // 确保 fakePage 不为 undefined
		console.log(`域名头部: ${hostTop} 反代地址: ${hub_host} searchInterface: ${fakePage}`);
		// 更改请求的主机名
		url.hostname = hub_host;
		const hubParams = ['/v1/search', '/v1/repositories'];
		if (屏蔽爬虫UA.some(fxxk => userAgent.includes(fxxk))) {
			// 首页改成一个nginx伪装页
			return new Response(await nginx(), {
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
		} else if ((userAgent && userAgent.includes('mozilla')) || hubParams.some(param => url.pathname.includes(param))) {
			if (url.pathname == '/') {
				if (env.URL302) {
					return Response.redirect(env.URL302, 302);
				} else if (env.URL) {
					if (env.URL.toLowerCase() == 'nginx') {
						//首页改成一个nginx伪装页
						return new Response(await nginx(), {
							headers: {
								'Content-Type': 'text/html; charset=UTF-8',
							},
						});
					} else return fetch(new Request(env.URL, request));
				} else	{
					if (fakePage) return new Response(await searchInterface(), {
						headers: {
							'Content-Type': 'text/html; charset=UTF-8',
						},
					});
				}
			} else {
				// 搜索结果页：使用自建页面，数据走 index.docker.io 的 /v1/search 接口，
				// 避免反代 hub.docker.com 搜索 API 时因 Workers 共享出口 IP 被限流（429 Rate limit exceeded）
				if (fakePage && url.pathname == '/search') {
					return new Response(await searchResultsPage(), {
						headers: {
							'Content-Type': 'text/html; charset=UTF-8',
						},
					});
				}
				// 新增逻辑：/v1/ 路径特殊处理
				if (url.pathname.startsWith('/v1/')) {
					url.hostname = 'index.docker.io';
				} else if (fakePage) {
					url.hostname = 'hub.docker.com';
				}
				if (url.searchParams.get('q')?.includes('library/') && url.searchParams.get('q') != 'library/') {
					const search = url.searchParams.get('q');
					url.searchParams.set('q', search.replace('library/', ''));
				}
				const newRequest = new Request(url, request);
				return fetch(newRequest);
			}
		}

		// 处理token请求
		if (url.pathname === '/token') {
			// 客户端只知道 nginx 这样的短名，Docker Hub 官方镜像的 scope 要补上 library/
			const scopes = url.searchParams.getAll('scope');
			url.searchParams.delete('scope');
			for (const scope of scopes) {
				url.searchParams.append('scope', /^repository:[^/:]+:/.test(scope) ? scope.replace('repository:', 'repository:library/') : scope);
			}
			let token_url = auth_url + url.pathname + url.search;
			return fetch(new Request(token_url, request), { headers: pickHeaders('User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding', 'Authorization') });
		}

		// 修改 /v2/ 请求路径
		if (hub_host == 'registry-1.docker.io' && /^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !/^\/v2\/library/.test(url.pathname)) {
			//url.pathname = url.pathname.replace(/\/v2\//, '/v2/library/');
			url.pathname = '/v2/library/' + url.pathname.split('/v2/')[1];
			console.log(`modified_url: ${url.pathname}`);
		}

		// 构造请求参数
		const parameter = { headers: pickHeaders('User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding', 'Authorization', 'Range', 'X-Amz-Content-Sha256') };

		// 没带令牌的客户端（浏览器、curl、群晖）：先替它获取匿名拉取令牌
		const repo = url.pathname.match(/^\/v2\/(.+?)\/(?:manifests|blobs|tags)\//)?.[1];
		if (hub_host === 'registry-1.docker.io' && repo && !parameter.headers.has('Authorization')) {
			const tokenRes = await fetch(`${auth_url}/token?service=registry.docker.io&scope=repository:${repo}:pull`, {
				headers: pickHeaders('User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding'),
			}).catch(() => null);
			const token = tokenRes?.ok && (await tokenRes.json().catch(() => null))?.token;
			// 拿不到令牌就不带，让上游返回正常的 401 认证质询
			if (token) parameter.headers.set('Authorization', `Bearer ${token}`);
		}

		// 发起请求并处理响应
		const original_response = await fetch(new Request(url, request), parameter);
		const new_response_headers = new Headers(original_response.headers);

		// 修改 Www-Authenticate 头
		const www_authenticate = new_response_headers.get("Www-Authenticate");
		if (www_authenticate) new_response_headers.set("Www-Authenticate", www_authenticate.replaceAll(auth_url, workers_url));

		// 处理重定向
		if (new_response_headers.get("Location")) {
			const location = new_response_headers.get("Location");
			console.info(`Found redirection location, redirecting to ${location}`);
			return httpHandler(request, location, hub_host);
		}

		// 直接转发上游 body；clone() 后没人读的那一半会被缓存在内存里
		return new Response(original_response.body, {
			status: original_response.status,
			headers: new_response_headers
		});
	}
};

/**
 * 跟随上游重定向（如 blob 跳转到 CDN）并转发响应
 * @param {Request} req 请求对象
 * @param {string} location 重定向地址
 * @param {string} baseHost 基地址
 */
async function httpHandler(req, location, baseHost) {
	const reqHdrNew = new Headers(req.headers);
	reqHdrNew.delete("Authorization"); // 修复s3错误

	const res = await fetch(new URL(location, 'https://' + baseHost), {
		method: req.method,
		headers: reqHdrNew,
		redirect: 'follow',
		body: req.body
	});
	const resHdrNew = new Headers(res.headers);
	const status = res.status;
	resHdrNew.set('access-control-expose-headers', '*');
	resHdrNew.set('access-control-allow-origin', '*');
	resHdrNew.set('Cache-Control', 'max-age=1500');

	// 删除不必要的头
	resHdrNew.delete('content-security-policy');
	resHdrNew.delete('content-security-policy-report-only');
	resHdrNew.delete('clear-site-data');

	return new Response(res.body, {
		status,
		headers: resHdrNew
	});
}

async function ADD(envadd) {
	var addtext = envadd.replace(/[	 |"'\r\n]+/g, ',').replace(/,+/g, ',');	// 将空格、双引号、单引号和换行符替换为逗号
	if (addtext.charAt(0) == ',') addtext = addtext.slice(1);
	if (addtext.charAt(addtext.length - 1) == ',') addtext = addtext.slice(0, addtext.length - 1);
	const add = addtext.split(',');
	return add;
}
