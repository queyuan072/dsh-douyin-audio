# 抖音通知接口 · 权威结构（重建版）

> **为什么是"重建版"**：原文件放在 `_diag/notes-probe/`（该目录在 `.gitignore` 里，见第 14 行 `_diag/`），从未进版本库，随 2026-11 工作区清空一起丢失。本次改放到 `docs/`（被跟踪），避免再丢一次。
> 本文件于 2026-11-25 依据 `scripts/douyin_read.py` 里的实测注释与实现重建，**唯一事实来源是代码**：
> `NOTICE_API_PATH` / `NOTICE_API_QS` / `NOTICE_API_STATIC_GROUPS`（常量区）
> 与 `_notice_api_fetch` / `_notice_map` / `_notice_count_groups` / `cmd_notes`（实现区）。
> 行号会漂移，按符号名检索；两者冲突时以代码为准。

## 1. 请求

```
GET https://www.douyin.com/aweme/v1/web/notice/?<NOTICE_API_QS>&notice_group=<GROUP>
```

**NOTICE_API_QS（实测可用，一字不改也能跑）**

```
device_platform=webapp&aid=6383&channel=channel_pc_web&is_new_notice=1
&is_mark_read=0&count=10&min_time=0&max_time=0
&version_code=170400&version_name=17.4.0&pc_client_type=1&platform=PC
```

要点（全部实测）：

- **参数名是 `notice_group`，不是 `notice_type`** —— 旧药方整条方向是错的。
- `notice_group` **必填**：不带给 `status_code=5`（参数不合法）；带上给 0。
- **不需要任何签名**：`a_bogus` / `msToken` / `verifyFp` / `fp` / `webid` / `uifid` 全部剥掉仍 `sc=0` 正常返回。这是"纯 HTTP、不开浏览器"能成立的根本原因。
- `version_code`：`170400` 与 `190500` **都能拿到数据**（"190500 拿不到"的旧记录已被实测证伪）；`170400` 是浏览器真实发出的值，沿用无害但非必需。
- 请求头：桌面 Edge UA + `Referer: https://www.douyin.com/` + `Accept` + `Cookie` + `Accept-Encoding: identity`。
- `is_mark_read`：实测 `1` / `0` / 不带，三者返回数据完全一样；取 `0` 以兑现"不点已读"契约（**服务端是否真的遵守未验证**）。

## 2. 响应

- 数据在 **`notice_list_v2`**（`notice_list` 在全部实测样本里恒为空数组，v2 才是真的；v2 为空时才回退 v1，留条后路）。
- `notice_list_v2` 为 `null` 或空数组 = **成功的空**，不是结构变化（实测出现过 null）。
- 其它顶层键：`extra` / `has_more` / `max_time` / `min_time` / `notice_config` / `notice_fold` / `notice_settings` / `notice_tab` / `type_list` / `status_code` / `status_msg`。

## 3. 错误码（机读 errorKind）

| status_code | errorKind | 含义 / 处理 |
| --- | --- | --- |
| 0 | ok | 成功（空列表也是成功） |
| 5 | bad_params | 参数不合法，多半是缺 `notice_group` 或抖音改了参数要求 |
| 8 | not_login | 用户未登录；cookie 过期/无效，先跑 `scripts/douyin_login.py` |
| 其它 | unknown_code | 未实测过的码，如实上报、不猜 |
| HTTP/网络异常 | network | 网络层失败 |
| 缺 `status_code` 键 / 两列表都不是数组 | structure | 接口结构可能已变，附顶层键清单 |

单个分组请求失败按降级处理（记 diag 继续下一组）；只有 `not_login` 中止整条命令。

## 4. 分组（notice_group）

- 候选 = **count 接口当前非零分组（动态，每次现取）** + 静态兜底 `[960, 700, 401, 2]`。
- count 接口：`GET /aweme/v1/web/notice/count/?device_platform=webapp&aid=6383`。
- 实测覆盖：

| group | 内容 |
| --- | --- |
| 960 | type 31 ×2 + type 33 ×3（聚合） |
| 700 | 同 960 |
| 401 | type 33（关注） |
| 2 | type 31（评论） |
| 601 / 961 / 3 / 7 / 28 / 64 | 空 |

- **非零分组号是动态的**：同一账号两次采样就可能不同，必须现取，不能写死。
- ⚠️ 推断未核实：count 接口可能只统计**未读**——通知全部已读时其非零分组恒为空，此时结果完全依赖静态兜底组，`cmd_notes` 会在 diag 里给显式风险提示。

## 5. 字段映射（type）

只认实测过的两种；**未知 type 不猜字段**（type 数字带上、user/text/url 留空，diag.unsupportedTypes 记录）。

| type | 含义 | 路径 |
| --- | --- | --- |
| 31 | 评论 | `comment.comment.user.nickname` / `comment.comment.text` / `comment.comment.aweme_id` → `https://www.douyin.com/video/<aweme_id>`；头像 `user.avatar_thumb` |
| 33 | 关注 | `follow.from_user.nickname` / `follow.content` / `follow.from_user.sec_uid` → `https://www.douyin.com/user/<sec_uid>`；头像 `from_user.avatar_thumb` |

时间：`create_time`（unix 秒）→ 本地 `YYYY-MM-DD HH:MM:SS`；取不出就清洗原样返回，排序键缺失视为最旧。

`general_notice` 子对象是**未验证路径**：实测其 `title` / `content` / `sender_name` 全为空串（只有 `schema_text="查看详情"`），因此仅当非空才启用填空，并在条目标 `unverified: true`。

## 6. 覆盖范围与限制

- 每个分组**只拉第一页**（`count=10`）：结果按 `create_time` 新→旧排序，但**不保证是全局最新 N 条**。
- 按 `nid` 去重（多分组聚合时同一通知会重复出现）。
- 已验证：药方可用、免签名、`notice_group` 必填、`notice_list_v2` 为数据源、type 31/33 字段路径（5 条真实通知样本）、上述分组覆盖、错误码 0/5/8。
- 未验证：`is_mark_read` 是否真被服务端遵守；count 是否只统计未读；`general_notice` 何时非空；更多 type 的字段路径。