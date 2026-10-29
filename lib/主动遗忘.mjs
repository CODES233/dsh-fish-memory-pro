// 鱼的记忆 · 「主动遗忘」（dsh-fish-memory-pro 加的）
//
// 一句话：**先记住，再忘掉；只忘已经记住的。**
//
// 上游 v1.3.7 的记忆是「模型自己想起来记」（remember 工具）；聊得太长、官方压缩一来，
// 前面没记下来的那段就真没了。这个文件补上那一段：
//
//     量压力 → 够了就把「还没记的那段原文」提炼成记忆条目写进库
//            → **全部写成功之后**，才调 DSH 官方的压缩接口把那批原文 folded 掉
//
// 为什么必须这个顺序：压缩是不可逆的。先压缩、后提炼，模型看不到原文就再也记不回来了。
//
// ⚠ 三件事一定不能错：
//   ① **不阻塞这一轮**：这里所有模型调用 / 压缩都在「agent 空了」之后才跑，
//      钩子里只做一次同步的量压力。
//   ② **没记住就不许忘**：任何一批失败 → 不推进度、不压缩，只写日志。
//   ③ **开关默认关**：关着的时候一条钩子都不干活，行为跟上游一模一样。
//
// 客户端（设置页）不碰这个文件：这里只有宿主半边。

import { 是材料 } from './生成档案.js'

// ═══════════════════════════════════════════════════════
// 一、配置（全走插件已有的 fish-memory-config.json，不新开文件）
// ═══════════════════════════════════════════════════════

export const 默认配置 = {
  开关: false,     // cordis.patch.yml 里 config.主动遗忘 / 配置文件的「主动遗忘」
  触发比例: 0.55,  // 用量到窗口的几成开始动手（官方自动压缩默认 0.8，我们抢在它前面）
  保留轮: 8,       // 最近的这么多轮原文一律不动（留给眼前对话用）
  间隔轮: 5,       // 两次成功抽取之间至少隔几轮
  每批字: 12000,   // 一批最多多少字（太大了模型会飘）
  每批条: 6,       // 一批最多提炼出几条（写进提示词里）
  失败冷却分: 10,  // 一次失败之后，同一段原文隔多久才重试
}

// 进度存在同一个配置文件的「遗忘进度」里：{ <会话id>: { seq, 轮, 时 } }
// 为什么不塞记忆库：loadStore() 只认 memories / traces / deleted 这几个字段，
// 多写的字段下次读回来就没了（上游自己就是这么过滤的）。
export const 进度键 = '遗忘进度'

function 取数(值, 默认, 下限, 上限) {
  const n = Number(值)
  if (!Number.isFinite(n)) return 默认
  return Math.min(上限, Math.max(下限, n))
}

/**
 * 读配置：插件 config（cordis.patch.yml 里的）优先，其次配置文件，最后默认值。
 * @param {object} 依赖 - 宿主注入（loadCfg）
 * @param {object} 插件配置 - apply(ctx, config) 收到的第二参
 * @param {object} [文件] - 已经读好的配置文件（一轮里要读好几项时省两次读盘）
 */
export function 读配置(依赖, 插件配置, 文件) {
  if (文件 === undefined) {
    try {
      文件 = (依赖 && 依赖.loadCfg && 依赖.loadCfg()) || {}
    } catch (error) {
      文件 = {}
    }
  }
  if (!文件 || typeof 文件 !== 'object') 文件 = {}
  const 取 = (键, 默认) => {
    const 甲 = 插件配置 && typeof 插件配置 === 'object' ? 插件配置[键] : undefined
    if (甲 !== undefined && 甲 !== null) return 甲
    const 乙 = 文件 ? 文件[键] : undefined
    if (乙 !== undefined && 乙 !== null) return 乙
    return 默认
  }
  return {
    开关: 取('主动遗忘', 默认配置.开关) === true,
    触发比例: 取数(取('遗忘触发比例', 默认配置.触发比例), 默认配置.触发比例, 0.2, 0.95),
    保留轮: Math.round(取数(取('保留最近轮', 默认配置.保留轮), 默认配置.保留轮, 1, 500)),
    间隔轮: Math.round(取数(取('遗忘检查间隔轮', 默认配置.间隔轮), 默认配置.间隔轮, 1, 500)),
    每批字: Math.round(取数(取('每批最多字', 默认配置.每批字), 默认配置.每批字, 1000, 200000)),
    每批条: Math.round(取数(取('每批最多条数', 默认配置.每批条), 默认配置.每批条, 1, 50)),
    失败冷却分: Math.round(取数(取('失败冷却分钟', 默认配置.失败冷却分), 默认配置.失败冷却分, 0, 1440)),
  }
}

export function 读进度(依赖, sid, 文件) {
  try {
    const c = 文件 === undefined ? 依赖.loadCfg() || {} : 文件 || {}
    const 表 = c && typeof c[进度键] === 'object' && c[进度键] ? c[进度键] : {}
    const v = 表[String(sid)]
    if (v && typeof v === 'object') {
      return {
        seq: Number.isFinite(v.seq) ? Number(v.seq) : -1,
        轮: Number.isFinite(v.轮) ? Number(v.轮) : 0,
      }
    }
  } catch (error) {}
  return { seq: -1, 轮: 0 }
}

export function 写进度(依赖, sid, 值) {
  try {
    const c = 依赖.loadCfg() || {}
    const 表 = c && typeof c[进度键] === 'object' && c[进度键] ? Object.assign({}, c[进度键]) : {}
    表[String(sid)] = 值
    c[进度键] = 表
    return !!依赖.saveCfg(c)
  } catch (error) {
    return false
  }
}

// ═══════════════════════════════════════════════════════
// 二、从会话事件里挑「该提炼的那一段」
// ═══════════════════════════════════════════════════════
//
// ⚠ 只认两种事件：user/message、assistant/message。其余（tool/call、tool/result、
//   step/*、job/* ……）都不是「话」。
//
// ⚠⚠ 但 user/message 里有**一大半不是用户说的话** —— DSH 自己把运行时提示、
//   技能清单、工作区规矩都塞成 user 角色。实测这间工作区 2918 条 user/message 里，
//   真正是「人说的话」只有 1340 条（user 200 + qq 1140），其余全是注入。
//   不挡掉的话，模型会把「当前工作目录是 X」「你有这些技能」当成事实记进记忆 ✗
//
// 判据用 data.source.kind：未知的 kind 一律当「人说的话」（别的桥接插件也能进来），
// 只挡下面这些**结构性噪音**。
const 噪音来源 = new Set([
  'runtime-context',      // 运行时上下文快照
  'time-context',         // 时间快照
  'agent-instructions',   // AGENTS.md / CLAUDE.md
  'skill-catalog',        // 技能清单
  'tool-jobs',            // 后台任务清单
  'schedule',             // 定时提醒
  'subagent-settled',     // 子代理收尾通知
  'agent-message',        // 别的 agent 转进来的话（不是对话）
  'subagent-descriptor',
  'repeat-tool-reminder', // 「你在重复同一个工具调用」
  'model-selection',      // 换模型通知
  'user-approval',        // 审批回执
  'speak-up',             // 插件替助手塞进去的「念头」，不是用户说的
])

function 是噪音来源(来源) {
  const k = 来源 && typeof 来源.kind === 'string' ? 来源.kind : ''
  if (!k) return false
  if (噪音来源.has(k)) return true
  // 别的插件注入的内容一律不进记忆（它们自己会管自己的记忆）
  if (k === 'plugin' || k.startsWith('plugin:')) return true
  return false
}

/** 一条事件里的「话」—— 只要 text 块；思考、工具调用都不算话。 */
export function 取文本(事件) {
  if (!事件 || !事件.data) return ''
  const 是用户 = 事件.type === 'user/message'
  const 消息 = (事件.data && 事件.data.message) || 事件.data || {}
  if (是用户 && 是噪音来源(事件.data.source)) return ''
  const c = 消息.content
  const 段们 = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
  const 段 = []
  for (const s of 段们) {
    if (!s || s.type !== 'text') continue
    const t = String(s.text || '')
    if (!t.trim()) continue
    段.push(t)
  }
  const 文 = 段.join('\n')
  if (!文) return ''
  // 上游那套「这不是聊天、是材料」的筛子（贴进来的整份记忆卡 / 插件任务提示 / 英文运行时提示）
  if (是材料(文)) return ''
  return 文
}

/**
 * 挑出这次要提炼的行。
 * 范围：**上次记到的位置之后** → **最近「保留最近轮」轮之前**。
 *
 * @param {Array} 事件们 - session.snapshotEvents()
 * @param {number} 起点seq - 上次记到的位置（-1 = 从头发）
 * @param {number} 保留轮 - 最近这么多轮不动
 * @returns {{行: Array, 末seq: number, 最大轮: number, 截止轮: number}}
 */
export function 选抽取区间(事件们, 起点seq, 保留轮) {
  const 排 = Array.isArray(事件们) ? 事件们 : []
  // 先给每条事件标上「第几轮」。turn/start 带 data.turn，
  // assistant/message 也带（个别会话没有 turn/start，就靠它兜底）。
  let 轮 = 0
  let 最大轮 = 0
  const 带轮 = []
  for (const e of 排) {
    if (!e || typeof e !== 'object') continue
    const t = e.data && Number.isFinite(e.data.turn) ? Number(e.data.turn) : null
    if (e.type === 'turn/start' && t !== null) 轮 = t
    else if (t !== null && t > 轮) 轮 = t
    if (轮 > 最大轮) 最大轮 = 轮
    带轮.push({ e, 轮 })
  }
  const 截止轮 = 最大轮 - Math.max(0, Math.round(Number(保留轮) || 0))
  const 起点 = Number.isFinite(起点seq) ? Number(起点seq) : -1
  const 行 = []
  let 末seq = 起点
  for (const { e, 轮: r } of 带轮) {
    if (typeof e.seq !== 'number') continue
    if (e.seq <= 起点) continue
    if (r > 截止轮) continue
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
    const 文 = 取文本(e)
    if (!文) continue
    行.push({
      seq: e.seq,
      轮: r,
      谁: e.type === 'user/message' ? '用户' : '助手',
      时间: e.time,
      文,
    })
    if (e.seq > 末seq) 末seq = e.seq
  }
  return { 行, 末seq, 最大轮, 截止轮 }
}

/** 会话里有没有「压缩开了没关」（compaction/start 之后没有 compaction/end）。 */
export function 压缩中(事件们) {
  let 起 = -1
  let 止 = -1
  for (const e of (Array.isArray(事件们) ? 事件们 : [])) {
    if (!e) continue
    if (e.type === 'compaction/start' && typeof e.seq === 'number') 起 = Math.max(起, e.seq)
    else if (e.type === 'compaction/end' && typeof e.seq === 'number') 止 = Math.max(止, e.seq)
  }
  return 起 >= 0 && 止 < 起
}

// ═══════════════════════════════════════════════════════
// 三、切批 + 提示词 + 解析
// ═══════════════════════════════════════════════════════

export function 切批(行, 每批字) {
  const 上限 = Math.max(1000, Math.round(Number(每批字) || 默认配置.每批字))
  const 批们 = []
  let 当前 = []
  let 字 = 0
  for (const h of (Array.isArray(行) ? 行 : [])) {
    const n = String(h.文 || '').length
    if (字 + n > 上限 && 当前.length) {
      批们.push({ 行: 当前, 字 })
      当前 = []
      字 = 0
    }
    当前.push(h)
    字 += n
  }
  if (当前.length) 批们.push({ 行: 当前, 字 })
  return 批们
}

// 提示词：判据照上游「生成档案」那把尺子（一个星期四再看还有没有用），
// 但输出换成机器好认的 JSON 数组 —— 这条链路是自动的，解析失败就等于白干。
// @param {number} [最多条] - 一批最多要几条（配置项「每批最多条数」，默认 6）
export function 提炼系统(最多条) {
  const 上限 = Math.max(1, Math.round(Number(最多条) || 默认配置.每批条))
  return `你是长期记忆整理员。给你一段一个人和 TA 的 AI 伴侣之间的对话，
把**过了一个星期四再看还有用**的事提炼成记忆条目。

═══════════════════════════════════════
【不收】
═══════════════════════════════════════
· 某天吃了什么、几点睡、天气怎么样、某一次玩闹
· 某样东西坏了要修、寄了快递、花了多少钱、某天做了什么安排
· 助手对用户的猜测和劝说（「你累了」「你该早点睡」）
· 已经记过的（见最后的【已记清单】）
· 待办、「下次讲什么」这种
· 整理过程本身（进度到第几轮、哪条待确认、某条更正了）

═══════════════════════════════════════
【收】
═══════════════════════════════════════
· 用户这个人**一直是这样**的：性格、喜好、身体和病史、习惯、身世、
  长期的经济／住处／工作／家里
· 关系：怎么开始的、真正的转折、里程碑
· 定下来的：约定、规矩、口令、纪念日、称呼
· 用户说过的**重要的话**（引号里保留原话）
· 助手自己的设定（名字、外形、性格、说话方式）
· **长期不变**的技术事实（用什么模型、什么插件、什么环境）

═══════════════════════════════════════
【助手的话】
═══════════════════════════════════════
助手说的只有三种能收：① 助手自己的设定 ② 双方一起定下的（用户明确说过「好」「行」）
③ 用户明确认可过的。助手单方面说的、猜测的、劝的，一律不收。

═══════════════════════════════════════
【输出】
═══════════════════════════════════════
**只输出一个 JSON 数组**，不要解释、不要代码围栏、不要前后多余的字。
每条形如：

{"内容": "一句话，一件事", "类型": "事件|长期事实|约定", "重要度": 0.5, "时间": "09-17 22:10"}

· 内容：一条只装一件事。人称用「我」指助手，用「ta」指用户；引号里保留原话。
· 类型：会变的事写「事件」；一直这样的事写「长期事实」；双方定下的写「约定」。
· 重要度：0 到 1 的小数（0.5 是默认；约定、关系、核心状态给 1）。
· 时间：照对话里标的时间写，写成「月-日 时:分」；实在看不出来就写 ""。
· 最多 ${上限} 条 —— 够不上就别凑，**0 条是常态**，那就只输出 []
· 同一件事只写一条；后面的话推翻了前面的，只留最后那条。`
}

function 两(数) {
  return String(数).padStart(2, '0')
}

/** 毫秒 → 「MM-DD HH:MM」（按这台机器的时区，不写死任何一个时区）。 */
export function 时刻(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  return 两(d.getMonth() + 1) + '-' + 两(d.getDate()) + ' ' + 两(d.getHours()) + ':' + 两(d.getMinutes())
}

export function 拼输入(批, 已记, 最多条) {
  const 清单 = !已记 || !已记.length ? '（还没有记过什么）' : 已记.join('\n')
  const user =
    批.行
      .map((h) => {
        const 时 = 时刻(h.时间)
        return '【' + (时 ? 时 + '　' : '') + h.谁 + '】\n' + h.文
      })
      .join('\n\n') + '\n\n【已记清单】\n' + 清单
  return { system: 提炼系统(最多条), user }
}

/**
 * 解析模型回的 JSON 数组。
 * ⚠ 这里**必须**能分清两种失败：
 *   · 模型说「没什么可记的」→ [] （成功，可以继续推进度）
 *   · 模型给了一堆看不懂的东西 → ok:false（失败，不推进度、不压缩）
 * 混在一起就会出现「模型抽风一次，那一整段原文被永久忘掉」。
 */
export function 解析条目(文本) {
  let s = String(文本 == null ? '' : 文本).trim()
  if (!s) return { ok: false, 原因: '模型什么都没回' }
  // 去掉代码围栏
  s = s.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  // 抓最外层的 [ ... ]
  const 头 = s.indexOf('[')
  const 尾 = s.lastIndexOf(']')
  if (头 < 0 || 尾 <= 头) return { ok: false, 原因: '回的里面没有 JSON 数组' }
  const 体 = s.slice(头, 尾 + 1)
  let 原
  try {
    原 = JSON.parse(体)
  } catch (error) {
    // 模型爱用中文引号 / 单引号 / 最后一个逗号 —— 试一次「洗一下再解析」，不行就认失败
    const 洗 = 体
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([\]}])/g, '$1')
    try {
      原 = JSON.parse(洗)
    } catch (error2) {
      return { ok: false, 原因: 'JSON 解析失败：' + String((error2 && error2.message) || error2).slice(0, 120) }
    }
  }
  if (!Array.isArray(原)) return { ok: false, 原因: '顶层不是数组' }
  const 条们 = []
  for (const x of 原) {
    if (!x || typeof x !== 'object') continue
    const 内容 = String(x.内容 == null ? '' : x.内容).trim()
    if (!内容 || 内容.length < 4) continue
    const 类型 = ['事件', '长期事实', '约定'].includes(String(x.类型)) ? String(x.类型) : '事件'
    let 重要度 = Number(x.重要度)
    if (!Number.isFinite(重要度)) 重要度 = 0.5
    重要度 = Math.min(1, Math.max(0, 重要度))
    // 「长期事实 / 约定」在上游就是 category=stable_profile（不会淡），
    // 上游的判据是 importance >= 1 —— 这里对齐，别自己发明一套 ✓
    if (类型 !== '事件') 重要度 = 1
    条们.push({
      内容: 内容.slice(0, 300),
      类型,
      重要度,
      时间: String(x.时间 == null ? '' : x.时间).trim().slice(0, 32),
    })
  }
  return { ok: true, 条们 }
}

// ═══════════════════════════════════════════════════════
// 四、跑一次（真正干活的地方）
// ═══════════════════════════════════════════════════════

// 失败重试冷却：模型报错 / 输出没法解析时不疯狂重试（一次 idle 一次调用会烧钱）。
// 冷却时长是配置项「失败冷却分钟」（默认 10，0 = 不冷却）。
const 上次失败 = new Map()        // sid → { 数: 失败时的事件数, 时: 毫秒 }
const 正在忘 = new Set()          // sid（自己记的「正在遗忘」标志，别重入）

function 取服务(ctx, 名) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const s = ctx.get(名)
      if (s) return s
    }
  } catch (error) {}
  try {
    return ctx ? ctx[名] : undefined
  } catch (error) {
    return undefined
  }
}

/** 这个会话正在用的窗口大小（contextWindow）。 */
async function 取窗口(ctx, agent, 事件们, 依赖, 信号) {
  // ① 会话自己记着的（最便宜、最准）
  try {
    const rc = agent && agent.session && typeof agent.session.requestContext === 'function'
      ? agent.session.requestContext()
      : null
    const w = rc && rc.contextWindow
    if (Number.isFinite(w) && w > 0) return Number(w)
  } catch (error) {}
  // ② 最近的 request/context 事件（带 provider/model，也能拿去问宿主）
  let 目标 = null
  const 排 = Array.isArray(事件们) ? 事件们 : []
  for (let i = 排.length - 1; i >= 0; i--) {
    const e = 排[i]
    if (!e || e.type !== 'request/context' || !e.data) continue
    const w = e.data.contextWindow
    if (Number.isFinite(w) && w > 0) return Number(w)
    if (e.data.provider && e.data.model) 目标 = { provider: e.data.provider, model: e.data.model }
    break
  }
  // ③ 问宿主
  try {
    const t = 目标 || (依赖 && 依赖.取模型 ? 依赖.取模型(ctx, agent) : null)
    if (t && t.provider && t.model && ctx.llm && typeof ctx.llm.resolveModelInfo === 'function') {
      const info = await ctx.llm.resolveModelInfo(t.provider, t.model, 信号)
      const w = info && info.context && info.context.contextWindow
      if (Number.isFinite(w) && w > 0) return Number(w)
    }
  } catch (error) {}
  return 0
}

function 取已记清单(依赖, sid, 上限) {
  try {
    if (!依赖 || !依赖.loadStore) return []
    const d = 依赖.loadStore(sid)
    const ms = (d && Array.isArray(d.memories) ? d.memories : []).slice(-(上限 || 12))
    return ms
      .map((m) => '· ' + String((m && m.text) || '').replace(/\s+/g, ' ').slice(0, 100))
      .filter((x) => x.length > 2)
  } catch (error) {
    return []
  }
}

/**
 * 模型给的原始时间拼进正文前缀：`[10-29 08:10] ta 养了只橘猫`。
 *
 * TODO（等上游存储支持 at 字段再改）：上游 `remember` 落库时 `at` 恒为「写库那一刻」，
 *   loadStore/saveStore 认的字段就那几个，多写一个 `at` 也会被过滤掉。
 *   这里先拼进正文保住时间 —— 以后上游真给 `at` 开口子了，改成真字段、正文不再拼前缀。
 */
function 带时间(条) {
  const t = String((条 && 条.时间) || '').trim()
  const 正文 = String((条 && 条.内容) || '').trim()
  if (!t) return 正文
  return '[' + t + '] ' + 正文
}

/** 官方压缩的保留比例（dsh-compaction-basic 的 retainRatio，默认 0.16）。 */
function 官方保留比例(压缩) {
  const 候选 = [
    压缩 && 压缩.配置 && 压缩.配置.retainRatio,
    压缩 && 压缩.config && 压缩.config.retainRatio,
    压缩 && 压缩.spec && 压缩.spec.retainRatio,
    压缩 && 压缩.options && 压缩.options.retainRatio,
    压缩 && 压缩.retainRatio,
  ]
  for (const v of 候选) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0 && n < 1) return n
  }
  return 0.16
}

function 段字(事件) {
  const 消息 = (事件 && 事件.data && (事件.data.message || 事件.data)) || null
  const c = 消息 ? 消息.content : null
  const 段们 = typeof c === 'string' ? [c] : Array.isArray(c) ? c : []
  let n = 0
  for (const s of 段们) {
    if (typeof s === 'string') n += s.length
    else if (s && typeof s === 'object') n += String(s.text || '').length
  }
  return n
}

/**
 * 数一数整个会话、「保留窗」（第 截止轮 轮之后）各有多少字。
 * 只用来估比例，不挑内容、不过滤 —— 两边同一把尺子量，比例才有意义。
 */
function 估保留段(事件们, 截止轮) {
  let 总字 = 0
  let 留字 = 0
  let 轮 = 0
  for (const e of 事件们) {
    if (!e || typeof e !== 'object') continue
    const t = e.data && Number.isFinite(e.data.turn) ? Number(e.data.turn) : null
    if (e.type === 'turn/start' && t !== null) 轮 = t
    else if (t !== null && t > 轮) 轮 = t
    const 字 = 段字(e)
    if (!字) continue
    总字 += 字
    if (轮 > 截止轮) 留字 += 字
  }
  return { 总字, 留字 }
}

/**
 * 主动遗忘跑一次。
 * @returns {Promise<{动作: string, 抽取?: number, 写入?: number, 压缩?: boolean}>}
 */
export async function 跑一次(ctx, agent, 依赖, 配置) {
  const sid = 依赖.sessionIdOf(agent.session)
  if (!sid) return { 动作: '跳过：拿不到会话 id' }
  if (依赖.是子代理 && 依赖.是子代理(agent)) return { 动作: '跳过：子代理不挂记忆' }
  if (依赖.isEnabled && !依赖.isEnabled(sid)) return { 动作: '跳过：这个会话没开记忆' }

  const 会话 = agent.session
  const 事件们 = typeof 会话.snapshotEvents === 'function' ? 会话.snapshotEvents() || [] : []
  if (!事件们.length) return { 动作: '跳过：会话里还没有事件' }
  if (压缩中(事件们)) return { 动作: '跳过：正在压缩' }

  const 进度 = 读进度(依赖, sid)
  const { 行, 末seq, 最大轮, 截止轮 } = 选抽取区间(事件们, 进度.seq, 配置.保留轮)
  if (!行.length) return { 动作: '没有可抽取的新内容', 最大轮, 截止轮 }

  // 拿信号：给压缩用；顺手挂个超时，宁可放弃也不挂死
  const 控 = new AbortController()
  const 闹钟 = setTimeout(() => { try { 控.abort(new Error('主动遗忘超时')) } catch (error) {} }, 5 * 60 * 1000)
  try {
    const 批们 = 切批(行, 配置.每批字)
    const 已记 = 取已记清单(依赖, sid, 12)
    const 记住工具 = 依赖.makeRememberTool(ctx)
    let 抽到 = 0
    let 写入 = 0

    for (let i = 0; i < 批们.length; i++) {
      const 批 = 批们[i]
      const 输入 = 拼输入({ 行: 批.行 }, 已记, 配置.每批条)
      const r = await 依赖.问模型(ctx, agent, 输入.system, 输入.user, 1200)
      if (!r || !r.ok) {
        return { 动作: '失败：模型调用出错（' + String((r && r.message) || '?') + '）', 起: 进度.seq, 末: 末seq }
      }
      const 解析 = 解析条目(r.text)
      if (!解析.ok) return { 动作: '失败：' + 解析.原因, 起: 进度.seq, 末: 末seq }
      for (const 条 of 解析.条们) {
        抽到++
        const 结 = await 记住工具.execute(
          {
            text: 带时间(条),
            importance: 条.重要度,
            tags: [条.类型],
          },
          { agent, 主动遗忘: true },
        )
        if (结 && 结.ok) 写入++
        else 依赖.diag('主动遗忘：这条没写进去 →「' + 条.内容.slice(0, 40) + '」' + String((结 && 结.message) || ''))
      }
    }

    // ⚠ 只忘已经记住的：抽到几条就要写进去几条，差一条都不推进度
    if (写入 < 抽到) {
      return { 动作: '失败：抽到 ' + 抽到 + ' 条，只写进去 ' + 写入 + ' 条 —— 进度不推进、不压缩', 抽取: 抽到, 写入, 起: 进度.seq, 末: 末seq }
    }

    写进度(依赖, sid, { seq: 末seq, 轮: 最大轮, 时: new Date().toISOString() })
    依赖.diag('主动遗忘：' + sid + ' 记下了 ' + 写入 + ' 条（第 ' + (截止轮 < 0 ? 0 : 截止轮) + ' 轮往前，末 seq ' + 末seq + '）')

    // 记完了，才轮到忘
    const 计量 = 取服务(ctx, 'tokenMeter')
    const 压缩 = 取服务(ctx, 'compaction')
    if (!计量 || typeof 计量.measure !== 'function') return { 动作: '记完了（没有 tokenMeter，不压缩）', 抽取: 抽到, 写入 }
    if (!压缩 || typeof 压缩.compactNow !== 'function') return { 动作: '记完了（没有 compaction 服务，不压缩）', 抽取: 抽到, 写入 }
    const 窗口 = await 取窗口(ctx, agent, 事件们, 依赖, 控.signal)
    if (!窗口) return { 动作: '记完了（量不到窗口，不压缩）', 抽取: 抽到, 写入 }
    let 用量 = 0
    try {
      用量 = Number(计量.measure(会话).totalTokens) || 0
    } catch (error) {
      用量 = 0
    }
    if (用量 < 配置.触发比例 * 窗口) {
      return { 动作: '记完了，压力已回落（' + 用量 + '/' + 窗口 + '），不压缩', 抽取: 抽到, 写入 }
    }

    // ⚠ 压缩前的护栏：官方压缩保留的是「最近 retainRatio × 窗口」的 token。
    //   如果它留的还没我们这「保留最近轮」多，它就会折进第 截止轮 轮以后那段原文 ——
    //   那段我们还**没提炼过**（我们只提炼到截止轮），折掉就真没了。
    //   算不清就直接不压缩：晚点再压缩，比「刚记住就被折」强得多。
    const 保留比例 = 官方保留比例(压缩)
    const 官方留 = 保留比例 * 窗口
    const { 总字, 留字 } = 估保留段(事件们, 截止轮)
    const 我们留 = 总字 > 0 && 用量 > 0 ? (用量 * 留字) / 总字 : 0
    if (我们留 > 0 && 官方留 < 我们留) {
      依赖.diag(
        '主动遗忘：这次不压缩 —— 官方大约留 ' + Math.round(官方留) + ' token（' + 保留比例 + '×窗口 ' + 窗口 + '），' +
          '我们要护住的那 ' + Math.max(0, 截止轮) + ' 轮以后约 ' + Math.round(我们留) + ' token；' +
          '它一折就会吃到第 ' + (Math.max(0, 截止轮) + 1) + ' 轮以后还没提炼的原文',
      )
      return {
        动作: '记完了，但这次不压缩（官方会折进刚记住的区间）',
        抽取: 抽到,
        写入,
        官方留: Math.round(官方留),
        我们留: Math.round(我们留),
      }
    }

    // compactNow 只接受**空着的** agent（它要预留下一轮的入场券），
    // 所以这一步必须在 agent/status = idle 之后做，而且只做一次 ✓
    const 结果 = await 压缩.compactNow(agent, 控.signal)
    if (结果 === null) return { 动作: '记完了，官方说没有可折叠的', 抽取: 抽到, 写入 }
    const 省 = 结果 && Array.isArray(结果.shadowedSeqs) ? 结果.shadowedSeqs.length : 0
    依赖.diag('主动遗忘：压缩掉了 ' + 省 + ' 条（约 ' + Number((结果 && 结果.shadowedTokenCount) || 0) + ' token）')
    return { 动作: '记完并压缩了 ' + 省 + ' 条', 抽取: 抽到, 写入, 压缩: true }
  } finally {
    clearTimeout(闹钟)
  }
}

// ═══════════════════════════════════════════════════════
// 五、接线
// ═══════════════════════════════════════════════════════

/**
 * 挂上两个钩子。开关关着的时候**照样挂**（否则主人打开开关得重启一次），
 * 但钩子进函数第一步就退出去，一个模型调用、一次写库都不会发生。
 *
 * @param {object} ctx - 插件上下文
 * @param {object} 依赖 - 上游 index.js 注入的东西（见 index.js 里的调用处）
 * @param {object} 插件配置 - apply(ctx, config) 的第二参
 * @returns {{卸载: Function}}
 */
export function 创建主动遗忘(ctx, 依赖, 插件配置) {
  const 卸 = []

  // ① 每一轮结束、agent 空了 —— 量一次压力（同步、便宜，就是一次投影读数）
  const 看压力 = (agent) => {
    try {
      // 一轮只读一次配置文件：开关、阈值、进度都从这份快照里拿
      const 文件 = (() => {
        try {
          return (依赖 && 依赖.loadCfg && 依赖.loadCfg()) || {}
        } catch (error) {
          return {}
        }
      })()
      const 配置 = 读配置(依赖, 插件配置, 文件)
      if (!配置.开关) return
      const sid = 依赖.sessionIdOf(agent.session)
      if (!sid) return
      if (正在忘.has(sid)) return
      if (依赖.是子代理 && 依赖.是子代理(agent)) return
      if (依赖.isEnabled && !依赖.isEnabled(sid)) return

      const 计量 = 取服务(ctx, 'tokenMeter')
      if (!计量 || typeof 计量.measure !== 'function') return
      const 事件们 = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() || [] : []

      // 失败冷却：**只挡「同一段原文」的重试** —— 起点没变、内容也没多（事件数一样）
      // 才等冷却；新的一轮进来（事件变多了）就是新内容，不该被上一次失败冻住。
      const 上次 = 上次失败.get(sid)
      if (上次) {
        const 冷却 = 配置.失败冷却分 * 60 * 1000
        if (冷却 > 0 && 上次.数 === 事件们.length && Date.now() - 上次.时 < 冷却) return
      }
      const 窗口 = (() => {
        try {
          const rc = agent.session.requestContext ? agent.session.requestContext() : null
          return rc && Number(rc.contextWindow) > 0 ? Number(rc.contextWindow) : 0
        } catch (error) {
          return 0
        }
      })()
      if (!窗口) return
      let 用量 = 0
      try {
        用量 = Number(计量.measure(agent.session).totalTokens) || 0
      } catch (error) {
        return
      }
      if (用量 < 配置.触发比例 * 窗口) return
      if (压缩中(事件们)) return

      // 距上次成功抽取至少隔 N 轮
      const 进度 = 读进度(依赖, sid, 文件)
      const 现在轮 = (() => {
        let 轮 = 0
        for (const e of 事件们) {
          if (e && e.type === 'turn/start' && e.data && Number.isFinite(e.data.turn)) 轮 = Math.max(轮, Number(e.data.turn))
          else if (e && e.data && Number.isFinite(e.data.turn)) 轮 = Math.max(轮, Number(e.data.turn))
        }
        return 轮
      })()
      if (现在轮 - 进度.轮 < 配置.间隔轮) return

      // 放出去跑，**不 await** —— 这一轮已经结束了，但下一轮随时可能来，
      // 不能把用户堵在这儿等一次模型调用。
      正在忘.add(sid)
      依赖.diag('主动遗忘：压力 ' + 用量 + '/' + 窗口 + '（' + Math.round((用量 / 窗口) * 100) + '%），开始提炼')
      Promise.resolve()
        .then(() => 跑一次(ctx, agent, 依赖, 配置))
        .then((r) => {
          const 动作 = String((r && r.动作) || '完成')
          // 失败（含「只写进去几条」）才记冷却；成功就把冷却清掉
          if (动作.startsWith('失败')) 上次失败.set(sid, { 数: 事件们.length, 时: Date.now() })
          else 上次失败.delete(sid)
          依赖.diag('主动遗忘：' + 动作)
        })
        .catch((error) => {
          上次失败.set(sid, { 数: 事件们.length, 时: Date.now() })
          依赖.diag('主动遗忘出错（不压缩）：' + String((error && error.message) || error))
          try { ctx.logger && ctx.logger.warn && ctx.logger.warn('fish-memory: 主动遗忘失败：%s', String((error && error.message) || error)) } catch (error2) {}
        })
        .finally(() => 正在忘.delete(sid))
    } catch (error) {
      依赖.diag('主动遗忘：量压力出错 ' + String((error && error.message) || error))
    }
  }

  try {
    卸.push(ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      看压力(agent)
    }))
  } catch (error) {
    依赖.diag('主动遗忘：agent/status 挂不上 ' + String((error && error.message) || error))
  }

  return {
    卸载() {
      for (const d of 卸) {
        try {
          if (typeof d === 'function') d()
          else if (d && typeof d.off === 'function') d.off()
        } catch (error) {}
      }
      卸.length = 0
    },
  }
}
