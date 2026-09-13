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

- **`LICENSE` 文件**：已经有了（MIT，版权归 Pt-ll），`package.json` 里也写了 `"license": "MIT"`。
  打包时会一并放进 VSIX，并在清单里写上 `<License>`——市场页面上那行「License: MIT」
  就是从清单读的，这一步漏了页面会显示成「没有许可证」。
- **截图**：市场页面里放几张截图（Testing 面板、榜单 WebView、diff）会明显提升可信度。
  放到 `media/screenshots/`，在 README 里用相对路径引用即可。

## 路线 A：VS Code Marketplace（官方市场）

### 1. 创建 publisher **[你来]**

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>
2. 按页面引导创建 publisher：**ID 填 `YuChenZhong`**（与 `package.json` 里的 `publisher`
   一致，本仓库已经写成这个）。扩展 ID 因此是 `YuChenZhong.verdict`。

   创建页对 ID 的大小写可能有自己的要求（有些年份的页面会强制小写）。真遇到那种提示，
   就把三处一起改成市场接受的形式——`package.json` 的 `publisher`、本文档的示例命令、
   `test/integration/index.js` 的 `EXTENSION_ID`。

   **用户侧不受影响**，这点本仓库实测过：用带大写的清单装进 VS Code 后，
   `code --list-extensions` 显示的是小写形式 `yuchenzhong.verdict`——VS Code 会把扩展 ID
   归一成小写，查找也不区分大小写（集成测试用两种写法都能找到扩展）。所以 publisher 的
   大小写只影响发布这一步，不影响已经装上的人。

   发布前定下来最好：以后再改 ID，装过旧版本的人会看到两个扩展（旧的不会自动消失）。

### 2. 生成访问令牌（PAT） **[你来]**

1. 打开 <https://dev.azure.com> → 右上角用户设置 → **Personal access tokens** → New Token
2. **Organization** 选 `All accessible organizations`；**Scopes** 选 `Marketplace` → `Manage`
3. 生成后立刻复制：它只显示一次

### 3. 安装发布工具（这一步要联网）

```bash
npm install -g @vscode/vsce
vsce login YuChenZhong        # 粘上一步的 PAT（若报 Publisher not found，见上面的大小写说明）
```

### 4. 打包并发布

两种方式任选（两条路的产物都是精简的：我们自己的打包器走白名单，
`.vscodeignore` 则保证 `vsce` 自己打包时不会把源码、测试、样例数据一起塞进去）：

```bash
# 方式一：用本仓库自带的打包器产出 VSIX，再交给 vsce 上传
# （我们的打包器零依赖、离线可用；vsce 只负责上传与市场校验）
pnpm package
vsce publish --packagePath dist/verdict-0.0.1.vsix

# 方式二：完全交给 vsce 打包
vsce publish
```

发布成功后几分钟内会出现在
<https://marketplace.visualstudio.com/items?itemName=YuChenZhong.verdict>。

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

## 发布过程中真实遇到过的两类报错

这两条是首次发布时实际撞上的，记下来省得再摸索一遍。

**「所选的用户帐户在租户"Microsoft Services"中不存在…需要先将该帐户添加为该租户的外部用户」**

生成 PAT 时出现。意思是这个微软账号不属于任何 Azure DevOps 组织，而发布权限挂在
Microsoft Services 租户下。两个常见原因：

1. 这个账号从没建过 Azure DevOps 组织 → 去 <https://dev.azure.com> 用**同一个账号**
   创建一个（免费），再从这个组织里生成 PAT。
2. 登录 Azure DevOps 和登录市场的不是同一个账号 → 开隐私窗口重新登录，保证两边一致。

另一个更省事的选择是**根本不用 PAT**：在市场的 manage 页面用 "New extension → Visual Studio Code"
直接上传 VSIX。

**TF400898: An Internal Error Occurred. Activity Id: …**

Azure DevOps 服务端的内部错误，与你的操作、与扩展本身都无关（Activity Id 是给微软支持追踪用的）。
多数是瞬时的：等几分钟重试、换隐私窗口/浏览器重登、顺手看一眼 <https://status.dev.azure.com>。
如果反复出现，别跟它较劲——改用 Open VSX（完全不需要微软账号），或者等市场后台恢复。

## 这个仓库当前的状态

- `pnpm package` 产出的 VSIX 已在本机用 `code --install-extension` 装过一次，确认官方安装器
  接受它的清单（装完已卸载）。
- 但**还没有发布到市场**：上面标了 **[你来]** 的步骤都需要你的账号与浏览器操作。
- 发布前建议先确认三平台 CI 全绿，再升一次 `version`。
