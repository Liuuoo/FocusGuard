# FocusGuard

FocusGuard 是一个 Windows 本地使用时长监控 MVP。它不会显示托盘图标，启动后只提供本机管理网页。

## 运行

```powershell
npm start
```

后台启动，不显示控制台窗口：

```powershell
.\start-focusguard.ps1
```

以管理员权限启动：

```powershell
.\start-focusguard-admin.ps1
```

打开：

```text
http://127.0.0.1:37831
```

小孩查看页：

```text
http://127.0.0.1:37831/
```

管理页：

```text
http://127.0.0.1:37831/admin
```

第一次进入管理页时需要设置管理密码。

## 已支持

- 统计当前前台应用的今日使用时长
- 统计后台进程的今日运行时长
- 使用 DeepSeek 评估前台软件和浏览器标签页用途
- 娱乐、社交软件与娱乐网页共用每日总额度，达到额度后自动关闭软件或标签页
- 支持工作日、非工作日分别设置每日娱乐总额度
- 白名单软件不计入统计
- 后台运行专用忽略名单，用来过滤系统进程和监控自身进程
- 浏览器标题关键词白名单不计入统计
- 管理界面需要密码
- 从管理界面退出监控需要密码
- 不创建托盘图标

## 开机启动

用 PowerShell 运行：

```powershell
.\install-startup-task.ps1
```

删除开机启动：

```powershell
.\uninstall-startup-task.ps1
```

## 说明

当前版本在浏览器扩展没有上报时，会使用前台窗口标题做兜底统计；这种方式只能识别当前前台窗口，不能可靠读取后台标签页的 URL。推荐使用下面的浏览器强制安装方式。

如果目标软件本身是管理员权限运行的，FocusGuard 也需要管理员权限运行，否则 Windows 会拒绝关闭目标进程。

## 娱乐总额度

管理页中的“每日娱乐总额度”同时作用于前台娱乐软件和浏览器娱乐标签页。软件按可执行文件名和窗口标题进行 AI 分类，浏览器按 URL、标题和搜索词进行 AI 分类。娱乐和社交类别都会计入总额度。

AI 请求失败时使用本地规则兜底，分类结果会缓存一段时间，避免重复请求。

## 浏览器扩展

DeepSeek key 通过用户环境变量读取：

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "你的 key", "User")
```

临时调试安装扩展：

1. 打开 Edge 或 Chrome 的扩展管理页。
2. 开启开发人员模式。
3. 选择“加载解压缩的扩展”。
4. 选择本项目的 `browser-extension` 目录。

扩展只把当前活跃标签的 URL、标题和停留时间发给本机 `http://127.0.0.1:37831`。DeepSeek key 不会进入浏览器扩展。

## 浏览器强制安装

为了避免每次新开浏览器都重新导入，也避免普通用户在扩展页删除或禁用，使用管理员 PowerShell 运行：

```powershell
.\install-browser-force.ps1
```

脚本默认给 Edge 生成固定 ID，打包到本地，并写入 Edge 的企业强制安装策略。同时会关闭 Edge 扩展页的开发者模式，只允许 FocusGuard 这一个扩展，并启动常见浏览器安装包隔离。安装后重启浏览器即可；不需要再次加载解压缩扩展。需要同时管理 Chrome，或只管理 Chrome 时：

```powershell
.\install-browser-force.ps1 -Browser Both
.\install-browser-force.ps1 -Browser Chrome
```

强制安装项不能由普通浏览器用户禁用或删除，但拥有 Windows 管理员权限的人仍可以修改浏览器策略，这是 Windows 企业策略的权限边界。扩展本身不会显示托盘图标，也不会把 DeepSeek key 放入浏览器。

## 其他浏览器防绕过

FocusGuard 会阻止常见的 Chrome、Firefox、360、2345、夸克、Opera、Brave、Vivaldi、搜狗、QQ、UC 等浏览器进程启动，并扫描“下载”和“桌面”目录。检测到高置信度的浏览器安装包后，会移动到 `data\quarantine\browser-installers` 隔离目录，而不是误删普通文件。

如果需要禁止 Edge 的所有下载，可以使用管理员 PowerShell 运行：

```powershell
.\install-browser-force.ps1 -BlockAllEdgeDownloads
```

不带这个参数时，普通文件仍可下载；浏览器安装包仍由隔离程序处理。Edge 的强制策略、开发者模式策略和下载策略都需要重启 Edge 后生效。
