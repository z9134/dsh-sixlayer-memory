# 发布手册 · dsh-sixlayer-memory

> 目标：把插件发到 npm 并进插件市场，让别人 `dsh plugin add` 一行就能装。
> 本文只写**当前实测出来的**事实与命令，不写"应该可以"。

---

## 1. 名字：两次撞名，现已换成可用名

| 曾经想用的名字 | 现状 | 证据 |
|---|---|---|
| `dsh-workbench` | **已被 lee259 占用**（0.16.1，右侧文件工作台） | `npm view dsh-workbench` → author=lee259 |
| `dsh-memory-core` | **已被 Sacredbluedragon 占用**（0.1.10，隔离记忆包） | `npm view dsh-memory-core` → author=Sacredbluedragon |
| `dsh-sixlayer-memory` | **可用**（registry 返回 404） | `registry.npmjs.org/dsh-sixlayer-memory` → 404 |

已完成的改名（4 处代码 + 1 处 profile，全部由 `tools/rename-package.mjs` 执行并回读校验）：

- `package.json` → `name`
- `lib/client.js` → 注册 id、CSS 标记、日志前缀
- `lib/parts/installer.js` → 自报名与 User-Agent
- `cordis.patch.yml` → 插入行 `name`
- `~/.dsh/profiles/desktop/` → 新联接 + `dsh.profile.bundles`

preflight 全绿（G4 id=包名、G7 联接唯一、G9 三处一致）。

> ⚠️ **互操作提醒**：市场上那个 `dsh-memory-core` 插件同样注册了 `/api/memory-core` 前缀路由与 `memory-core` 注入段名。
> 两个同时装会撞路由（`duplicate prefix route`）。装本插件前先确认没装它。

---

## 2. 当前阻塞（需要你本人做的两件事）

1. **没有登录 npm**：`npm whoami` → `ENEEDAUTH`。
2. **registry 指向镜像**：`~/.npmrc` 里 `registry=https://registry.npmmirror.com`，镜像不能发布。

```powershell
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
```

---

## 3. 发布

```powershell
cd D:\001\CH002\dsh-memory-core

# 干跑一遍，确认文件数、无 .bak
npm pack --dry-run

# prepublishOnly 会自动跑 preflight + 30 个回归套件；不绿就发不出去
npm publish --registry https://registry.npmjs.org --access public
```

预期产物：`dsh-sixlayer-memory-2.0.0.tgz`，约 1.0 MB / 87 文件。

**发布前自检清单**

- [ ] `npm run check` 全绿
- [ ] `dsh plugin --profile <新profile> add dsh-sixlayer-memory` 能装上并启动
- [ ] 装上后 `mem_admin_catalog` 返回 32 个工具
- [ ] 市场详情页能打开（`locale/zh.json` → `docs/DETAIL.zh.md` → `docs/preview.svg`）
- [ ] 装完不配 `dataDir` 时数据落在 `<repo>/../dsh-memory-data`

---

## 4. 进市场

两条路，建议都做：

1. **社区索引 PR**：给 [dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins) 的 `community.json` 加一条（category=`knowledge`，subcategory=`memory`）。
2. **官网目录**：按 [dshplugin.online](https://dshplugin.online) 的提交说明填 npm 包名。

条目文案（可直接用）：

- 名称：`六层记忆底座`
- 一句话：`会先审后记、还带审计链的本地记忆。`
- 详情：见 `locale/zh.json` 的 `meta.description`

---

## 5. 回滚

```powershell
npm unpublish dsh-sixlayer-memory@2.0.0 --registry https://registry.npmjs.org   # 72 小时内
# 本地回滚 package.json 改名：
#   package.json.bak-rename-<ts>
#   ~/.dsh/profiles/desktop/package.json.bak-rename-<ts>
```

本地 profile 回滚后记得重建旧联接、把 `bundles` 换回旧名，再重启 DSH。
