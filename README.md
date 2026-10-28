[**第三方 DockerHub 镜像服务列表**](#%EF%B8%8F-%E7%AC%AC%E4%B8%89%E6%96%B9-dockerhub-%E9%95%9C%E5%83%8F%E6%9C%8D%E5%8A%A1)

![CF-Workers-docker.io](./img.png)

# 🐳 CF-Workers-docker.io：Docker仓库镜像代理工具

这个项目是一个基于 Cloudflare Workers 的 Docker 镜像代理工具。它能够中转对 Docker 官方镜像仓库的请求，解决一些访问限制和加速访问的问题。

> [!CAUTION]
> **docker.fxxk.dedyn.io 已被GFW污染，需自行部署使用。**

> [!WARNING]
> 根据 [Cloudflare 协议](https://www.cloudflare.com/zh-cn/terms/) 中，2.2.1 第 (j) use the Services to provide a virtual private network or other similar proxy services.
>
> 使用本服务可能存在被 Cloudflare 封号的潜在风险，请自行斟酌使用风险。
>
> 如果你选择了“根据主机名选择对应的上游地址”方式部署，你可能会:
> 
> 被 Netcraft 扫描到，收到警告邮件
>
> 被 Netcraft 同步到 Google Safe Browsing 标记为钓鱼网站
>
> 被 Netcraft 投诉到 Cloudflare 标记为钓鱼网站, 无法正常 pull 镜像
>
> 收到律师函

## 🚀 部署方式

以下步骤依据 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/)，按钮名称以控制台英文界面为准。三种方式任选其一：

### 方式一：Workers 关联 GitHub（推荐，推送后自动部署）

1. `Fork` 本仓库，把 [wrangler.jsonc](./wrangler.jsonc) 里的 `name` 改成你要用的 Worker 名称。
2. Cloudflare 控制台进入 **Workers & Pages** → **Create application**，选择 **GitHub**，授权后选中你 Fork 的仓库。
3. 项目名称填写与 `wrangler.jsonc` 中 `name` 完全相同的值（[不一致会构建失败](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)），部署命令保持默认的 `npx wrangler deploy`，点击 **Save and Deploy**。
4. 已有的 Worker 可以在 **Settings** → **Builds** → **Connect** 关联仓库。之后每次推送都会自动构建并部署。

`wrangler.jsonc` 中设置了 `keep_vars: true`，在控制台配置的环境变量不会被部署覆盖。

### 方式二：Workers 控制台粘贴代码

1. **Workers & Pages** → **Create application**，用 Hello World 模板创建一个 Worker 并点击 **Deploy**。
2. 打开这个 Worker，点击 **Edit code**，用本仓库 [_worker.js](./_worker.js) 的全部内容替换编辑器中的代码，再点击 **Deploy**。
3. 更新时重复第 2 步，旧部署不会自动获得新代码。

### 方式三：Pages 关联 GitHub

1. `Fork` 本仓库。
2. **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**，选中仓库后点击 **Begin setup**。
3. **Framework preset** 选 `None`，**Build command** 留空，**Build output directory** 保持默认，点击 **Save and Deploy**。仓库根目录的 `_worker.js` 会以 [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) 运行。
4. 之后每次推送都会自动部署。

### 绑定自定义域名

域名需要已经托管在 Cloudflare（处于 Active 状态）：

- **Worker**：打开 Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**，输入域名后点击 **Add Custom Domain**，Cloudflare 会自动创建 DNS 记录。该主机名不能已经存在 CNAME 记录。参见 [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
- **Pages**：打开项目 → **Custom domains** → **Set up a domain**，输入域名后点击 **Continue**。参见 [Pages 自定义域名](https://developers.cloudflare.com/pages/configuration/custom-domains/)。

## ⚙️ 如何使用？ [视频教程](https://www.youtube.com/watch?v=l2jwq9CagNQ)

例如您的Workers项目域名为：`docker.fxxk.dedyn.io`；

### 1.官方镜像路径前面加域名

```shell
docker pull docker.fxxk.dedyn.io/stilleshan/frpc:latest
```

```shell
docker pull docker.fxxk.dedyn.io/library/nginx:stable-alpine3.19-perl
```

### 2.一键设置镜像加速

修改文件 `/etc/docker/daemon.json`（如果不存在则创建），把域名替换为你自己的域名。JSON 文件里不能写注释：

```shell
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://docker.fxxk.dedyn.io"]
}
EOF
sudo systemctl restart docker
```

按 [Docker 官方说明](https://docs.docker.com/docker-hub/image-library/mirror/)，`registry-mirrors` 只对 Docker Hub 镜像生效，其他仓库请用第 4 节的方式。

### 3. 遇到 429 Too Many Requests

按 [Docker Hub 官方限额](https://docs.docker.com/docker-hub/usage/pulls/)，未登录的拉取按 IPv4 地址或 IPv6 /64 子网计算额度，登录的个人账号按账号计算、额度更高。实测 Workers 访问 Docker Hub 时使用 Cloudflare 共用的 IPv6 出口（`2a06:98c0:3600::`），所有 Workers 共享同一份匿名额度，基本一直是 0，所以匿名拉取 Docker Hub 镜像会返回 `429 toomanyrequests`。

用自己的 Docker Hub 账号登录镜像站后，就按个人账号额度计算：

```shell
docker login docker.fxxk.dedyn.io
docker pull docker.fxxk.dedyn.io/library/nginx:latest
```

登录凭据会经过镜像站转发给 Docker Hub，建议用只读权限的[个人访问令牌（PAT）](https://docs.docker.com/security/access-tokens/)代替密码（开启两步验证的账号必须用 PAT），并且只登录你信任的镜像站。用第 2 种 `registry-mirrors` 方式拉取 Docker Hub 镜像遇到 429 时，改用上面登录后带域名拉取的方式。GHCR、quay.io、registry.k8s.io 等其他仓库不受此限制。

### 4. 配置常见仓库的镜像加速

#### 4.1 Containerd（Kubernetes）

[containerd 官方文档](https://github.com/containerd/containerd/blob/main/docs/hosts.md)已将 `config.toml` 中 `registry.mirrors` 的写法标记为 DEPRECATED，推荐使用 `config_path` + `hosts.toml`。

第一步，确认 `/etc/containerd/config.toml` 中设置了 `config_path`，改完后执行 `sudo systemctl restart containerd`：

```toml
# containerd 2.x（配置文件 version = 3）
[plugins."io.containerd.cri.v1.images".registry]
   config_path = "/etc/containerd/certs.d"

# containerd 1.x（配置文件 version = 2）
[plugins."io.containerd.grpc.v1.cri".registry]
   config_path = "/etc/containerd/certs.d"
```

第二步，为每个要加速的仓库生成 `hosts.toml`，把 `MIRROR` 替换为你的域名。`server` 是镜像站不可用时回退的上游；按官方文档，修改 `certs.d` 目录下的文件不需要重启 containerd：

```shell
MIRROR=docker.fxxk.dedyn.io
for reg in docker.io registry.k8s.io k8s.gcr.io gcr.io ghcr.io quay.io; do
  server="https://$reg"; [ "$reg" = docker.io ] && server="https://registry-1.docker.io"
  sudo mkdir -p /etc/containerd/certs.d/$reg
  sudo tee /etc/containerd/certs.d/$reg/hosts.toml >/dev/null <<EOF
server = "$server"

[host."https://$MIRROR"]
  capabilities = ["pull", "resolve"]
EOF
done
```

containerd 请求镜像站时会带上 `?ns=原仓库`，Worker 据此选择上游，所以同一个域名可以加速以上所有仓库。为防止 Worker 被当成开放代理，`ns` 只接受 `docker.io` 和 `_worker.js` 中 `ROUTES` 路由表里的上游（quay.io、gcr.io、k8s.gcr.io、registry.k8s.io、ghcr.io、docker.cloudsmith.io、nvcr.io），其他值返回 400。需要别的仓库时，在 `ROUTES` 里加一行即可。

#### 4.2 Podman

修改 `/etc/containers/registries.conf`，格式见 [containers-registries.conf(5)](https://github.com/containers/image/blob/main/docs/containers-registries.conf.5.md)：

```toml
unqualified-search-registries = ["docker.io"]

[[registry]]
prefix = "docker.io"
location = "registry-1.docker.io"

[[registry.mirror]]
location = "docker.fxxk.dedyn.io"

[[registry]]
prefix = "ghcr.io"
location = "ghcr.io"

[[registry.mirror]]
location = "docker.fxxk.dedyn.io/ghcr.io"
```

Podman 会把镜像地址直接改写成镜像站地址再拉取，不会像 containerd 那样附带 `ns`，Worker 无从知道原仓库是哪个。所以同一个域名只能加速 Docker Hub，以及通过 `域名/ghcr.io` 路径加速 GHCR。quay.io、registry.k8s.io 等其他仓库需要给 Worker 绑定对应前缀的子域名（如 `quay.你的域名`、`k8s.你的域名`，前缀见 `ROUTES`），再把 mirror 的 `location` 填成该子域名。这就是上方警告中提到的「根据主机名选择对应的上游地址」方式，请注意其中的风险。

#### 4.3 使用

配置完成后照常拉取，会自动经过镜像站：

```shell
crictl pull registry.k8s.io/kube-proxy:v1.28.4
podman pull ghcr.io/veildawn/ai-proxy-release:latest
```

### 5. GHCR 公开镜像查询与加速

首页输入 Docker Hub 关键词（如 `nginx`）仍使用 Docker Hub 搜索。输入完整 GHCR 地址则查询该公开镜像的标签，可翻页，也可指定标签或 SHA-256 摘要：

```text
ghcr.io/veildawn/ai-proxy-release
ghcr.io/veildawn/ai-proxy-release:latest
```

结果中可复制代理拉取命令。GHCR 使用同一域名的 `ghcr.io/` 路径前缀，无需新增 DNS 或自定义域名。例如部署域名为 `docker.shaniao.top`：

```shell
docker pull docker.shaniao.top/ghcr.io/veildawn/ai-proxy-release:latest
```

将示例中的域名替换为自己的域名。指定摘要时使用 `域名/ghcr.io/所有者/镜像名@sha256:摘要`。

兼容已有的 `ghcr.你的域名` 路由及 Containerd 的 `?ns=ghcr.io` 请求；新路径会保留所有者和镜像名，不添加 Docker Hub 的 `library/`。Worker 为 GHCR 获取独立的匿名拉取令牌，并中转 manifest 和 blob 下载。

此功能是**完整地址精确查询**，不提供 GHCR 全站关键词搜索；仅支持公开镜像的查询和拉取，不支持私有镜像或推送。公开容器镜像可匿名访问，参见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 🔧 变量说明

| 变量名 | 示例 | 必填 | 备注 |
|--|--|--|--|
| URL302 | `https://t.me/CMLiussss` |❌| 主页302跳转 |
| URL | `https://www.baidu.com/` |❌| 主页伪装(设为`nginx`则伪装为nginx默认页面) |
| UA | `netcraft` |❌| 支持多元素, 元素之间使用空格或换行作间隔，不区分大小写 |

设置方法（参见 [Workers 环境变量](https://developers.cloudflare.com/workers/configuration/environment-variables/)）：

- **Workers**：打开 Worker → **Settings** → **Variables and Secrets** → **Add**，类型选文本，填写名称和值后点击 **Deploy**。
- **Pages**：打开项目 → **Settings** → **Variables and Secrets** → **Add**，填写后点击 **Save**，再重新部署一次使其生效。

## 🧪 本地测试

需要 Node.js 22 及以上，无额外依赖。`tests/worker.test.mjs` 覆盖 Docker Hub 路由与认证、`ns` 白名单、UA 屏蔽、GHCR 查询与拉取，上游请求全部用 mock，不访问网络：

```shell
node --test tests/worker.test.mjs
# Workers 运行时回归（首次运行下载 Cloudflare 官方 workerd）
npm exec --yes --cache .wrangler/npm-cache --package=workerd@1.20260906.1 -- workerd test tests/workerd.capnp
# 可选：连接真实 GHCR，验证公开标签、manifest、blob、摘要和 Range 下载
node tests/ghcr-live.mjs
```

# 🛠️ 第三方 DockerHub 镜像服务

**注意:**

- 以下内容仅做镜像服务的整理与搜集，未做任何安全性检测和验证。
- 使用前请自行斟酌，并根据实际需求进行必要的安全审查。
- 本列表中的任何服务都不做任何形式的安全承诺或保证。

| DockerHub 镜像仓库 | 镜像加地址 |
| ------------------ | ----------- |
| [bestcfipas 镜像服务](https://t.me/bestcfipas/4018) | `https://docker.registry.cyou` |
|  | `https://docker-cf.registry.cyou` |
|  | `https://registry.lfree.org` |
| [zero_free 镜像服务](https://t.me/zero_free/80) | `https://docker.jsdelivr.fyi` |
|  | `https://docker.aeko.cn` |
| [mingyu 镜像服务](https://github.com/ymyuuu/HubP) | `https://hubp.de` |
| [Docker 镜像加速站](https://docker.1panel.live)  | `https://docker.1panel.live` |
| [Hub Proxy](https://hub.rat.dev) | `https://hub.rat.dev` |
| [DaoCloud 镜像站](https://github.com/DaoCloud/public-image-mirror) | `https://docker.m.daocloud.io` |

# 🙏 鸣谢
### 💖 赞助支持 - 提供云服务器
- [![digitalvirt.com](https://digitalvirt.com/templates/BlueWhite/img/logo-dark.svg)](https://url.cmliussss.com/dv)

### 🛠 开源代码引用
- [muzihuaner](https://github.com/muzihuaner)
- [V2ex网友](https://global.v2ex.com/t/1007922)
- [ciiiii](https://github.com/ciiiii/cloudflare-docker-proxy)
- [ChatGPT](https://chatgpt.com/)
- [白嫖哥](https://t.me/bestcfipas/1900)
- [zero_free频道](https://t.me/zero_free/80)
- [dongyubin](https://github.com/cmliu/CF-Workers-docker.io/issues/8)
- [kiko923](https://github.com/cmliu/CF-Workers-docker.io/issues/5)
