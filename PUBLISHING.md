# 发布到插件市场

这份文档写给「第一次发布 VS Code 扩展」的人。所有需要浏览器与账号的步骤都标了
**[你来]**——发布这件事必须有你的凭据，工具代替不了。

## 发布前先补齐三样

市场页面就是把 `README.md` 渲染出来，再加上 `package.json` 里的描述、图标和分类。
所以这三样是硬要求：

1. **README.md** — 有（仓库根目录），市场页直接用它。
2. **图标** — 有（`media/icon.png`，128×128 RGBA PNG；源图留在 `assets/icon-source.png`，
   想换图标时从源图导出 128×128 覆盖它即可）。
3. **`repository` 字段** — 有（指向 GitHub）。缺了它 `vsce` 会报错。

还有两样建议、但需要你自己决定：

- **`LICENSE` 文件**：没选许可证的话，别人在法律上不能用你的代码。MIT / Apache-2.0 是这类
  工具的常见选择。选好后放到仓库根，并在 `package.json` 里加 `"license": "MIT"`。
- **截图**：市场页面里放几张截图（Testing 面板、榜单 WebView、diff）会明显提升可信度。
  放到 `media/screenshots/`，在 README 里用相对路径引用即可。

## 路线 A：VS Code Marketplace（官方市场）

### 1. 创建 publisher **[你来]**

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>
2. 按页面引导创建 publisher：**ID 填 `yuchenzhong`**。
   市场只允许小写字母、数字和连字符，空格放不进 ID；带空格的显示名（`Yuchen Zhong`）是
   填在 publisher 资料页上的，不影响这里的 ID。

   **ID 必须与 `package.json` 里的 `publisher` 一致**——本仓库已经写成 `yuchenzhong`。
   扩展 ID 因此是 `yuchenzhong.verdict`；发布前定下来最好，因为以后再改 ID，装过旧版本的人
   会看到两个扩展（旧的不会自动消失）。

   想换成别的（比如与 GitHub 用户名一致的 `pt-ll`），要同时改三处：`package.json` 的
   `publisher`、本文档里的示例命令，以及 `test/integration/index.js` 里的 `EXTENSION_ID`
   （那条测试就是靠它找到扩展的，改漏了会直接红）。

### 2. 生成访问令牌（PAT） **[你来]**

1. 打开 <https://dev.azure.com> → 右上角用户设置 → **Personal access tokens** → New Token
2. **Organization** 选 `All accessible organizations`；**Scopes** 选 `Marketplace` → `Manage`
3. 生成后立刻复制：它只显示一次

### 3. 安装发布工具（这一步要联网）

```bash
npm install -g @vscode/vsce
vsce login yuchenzhong        # 粘上一步的 PAT
```

### 4. 打包并发布

两种方式任选：

```bash
# 方式一：用本仓库自带的打包器产出 VSIX，再交给 vsce 上传
# （我们的打包器零依赖、离线可用；vsce 只负责上传与市场校验）
pnpm package
vsce publish --packagePath dist/verdict-0.0.1.vsix

# 方式二：完全交给 vsce 打包
vsce publish
```

发布成功后几分钟内会出现在
<https://marketplace.visualstudio.com/items?itemName=yuchenzhong.verdict>。

### 5. 以后每次更新

市场不接受重复版本号，所以每次先升 `package.json` 里的 `version`：

```bash
npm version patch             # 0.0.1 -> 0.0.2（或 minor / major）
git push --follow-tags
pnpm package && vsce publish --packagePath dist/verdict-0.0.2.vsix
```

## 路线 B：Open VSX（VSCodium / Gitpod / Theia 用的是它）

如果你的用户里有不用官方 VS Code 的人，值得再发一份：

1. 用 GitHub 账号登录 <https://open-vsx.org> **[你来]**
2. 右上角头像 → Settings → Access Tokens → 生成 **[你来]**
3. 发布：

```bash
npx ovsx publish -p <你的 token> dist/verdict-0.0.1.vsix
```

## 常见被拒原因

| 现象 | 原因 |
| --- | --- |
| `Missing repository field` | `package.json` 里没有 `repository`（本仓库已补） |
| `Publisher 'xxx' not found` | `package.json` 的 `publisher` 与市场上创建的没对上 |
| 版本冲突 | 同一个版本号发了第二次，先 `npm version patch` |
| 图标不显示 | 不是 128×128 的 PNG，或 `package.json` 里忘了写 `icon` 字段 |
| 打包后体积异常 | 把 `node_modules/` 之类打进去了；本仓库的打包器按白名单来，不会有这个问题 |

## 这个仓库当前的状态

- `pnpm package` 产出的 VSIX 已在本机用 `code --install-extension` 装过一次，确认官方安装器
  接受它的清单（装完已卸载）。
- 但**还没有发布到市场**：上面标了 **[你来]** 的步骤都需要你的账号与浏览器操作。
- 发布前建议先确认三平台 CI 全绿，再升一次 `version`。
