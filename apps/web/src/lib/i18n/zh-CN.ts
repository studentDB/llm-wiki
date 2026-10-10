/**
 * Chinese is the source of truth for the message catalogue: `MessageKey` is
 * derived from this object, so forgetting a translation in `en.ts` is a
 * compile error rather than a blank label in production.
 *
 * Default locale for the whole app — see DEFAULT_LOCALE.
 */
export const zhCN = {
  // ---- common ----
  "common.appName": "LLM Wiki",
  "common.home": "首页",
  "common.save": "保存",
  "common.cancel": "取消",
  "common.delete": "删除",
  "common.edit": "编辑",
  "common.retry": "重试",
  "common.close": "关闭",
  "common.search": "搜索",
  "common.loading": "加载中…",
  "common.empty": "暂无内容",
  "common.error": "出错了",
  "common.optional": "可选",
  "common.required": "必填",

  // ---- navigation ----
  "nav.wiki": "词条",
  "nav.graph": "图谱",
  "nav.sources": "素材",
  "nav.query": "问答",
  "nav.chats": "会话",
  "nav.lint": "体检",
  "nav.schema": "契约",
  "nav.settings": "设置",
  "nav.manageWikis": "管理知识库 →",
  "nav.openMenu": "打开菜单",

  // ---- wiki ----
  "wiki.title": "词条",
  "wiki.index": "词条索引",
  "wiki.searchPlaceholder": "筛选词条…",
  "wiki.empty.title": "还没有词条",
  "wiki.empty.body": "上传一份素材或从粘贴文本开始，LLM 会自动生成词条。",
  "wiki.backlinks": "反向链接",
  "wiki.history": "历史",
  "wiki.deletePage": "删除词条",
  "wiki.restorePage": "恢复词条",

  // ---- sources ----
  "sources.title": "素材",
  "sources.upload": "上传素材",
  "sources.dropHint": "拖入文件，或点击选择（支持 PDF / Word / Excel / PPT / 网页 / 文本）",
  "sources.empty.title": "还没有素材",
  "sources.empty.body": "上传文档后会自动抽取内容并生成词条。",
  "sources.status.pending": "待处理",
  "sources.status.ingested": "已入库",
  "sources.status.failed": "失败",
  "sources.reingest": "重新入库",
  "sources.ingestedList": "已入库素材",
  "sources.titleField": "标题",
  "sources.originalsHint": "原始文件保存在",
  "sources.dropHere": "把文件拖到这里，或",
  "sources.chooseOne": "点击选择",
  "sources.titlePlaceholder": "留空则取首行（粘贴）、网页标题或文件名",
  "sources.pastePlaceholder": "粘贴文章、论文或笔记…",
  "sources.ingest": "入库",
  "sources.ingesting": "入库中…",
  "sources.hintVision": "多模态调用 —— 使用「设置 → 模型 → vision」里的模型。",
  "sources.hintText": "文本调用 —— 使用 ingest 槽模型，常规素材约 10–30 秒。",
  "sources.headDescription":
    "粘贴文本与 Markdown 直接入库；URL 通过 Readability 抓取抽取；PDF 与图片走多模态模型；DOCX/PPTX/XLSX 在本地预解析。",

  // ---- query ----
  "query.title": "问答",
  "query.placeholder": "就这个知识库提问…",
  "query.example": "例如：压力校验仪的校准流程是怎样的？",
  "query.ask": "提问",
  "query.asking": "提问中…",
  "query.thinking": "正在检索并作答…",
  "query.headDescription": "向知识库提问并获得带引用的回答，适合一次性查询；持续对话请用「会话」。",

  // ---- chats ----
  "chats.title": "会话",
  "chats.new": "新建会话",
  "chats.empty.title": "还没有会话",
  "chats.inputPlaceholder": "输入消息…",

  // ---- lint ----
  "lint.title": "体检",
  "lint.run": "开始体检",
  "lint.running": "体检进行中…",
  "lint.noIssues": "没有发现问题",
  "lint.issues": "发现 {count} 个问题",

  // ---- dashboard ----
  "dashboard.title": "概览",
  "dashboard.pages": "词条数",
  "dashboard.sources": "素材数",
  "dashboard.cost": "累计花费",

  // ---- settings ----
  "settings.title": "设置",
  "settings.tabs.general": "常规",
  "settings.tabs.models": "模型",
  "settings.tabs.api": "API 密钥",
  "settings.tabs.costs": "费用",
  "settings.tabs.wikis": "知识库",
  "settings.tabs.about": "关于",
  "settings.general.topic": "知识库主题",
  "settings.general.topicHint": "描述这个知识库的范围。留空会导致首跑向导反复出现。",
  "settings.general.autoLint": "入库后自动体检",
  "settings.general.showCosts": "显示费用估算",
  "settings.general.requireApproval": "入库前需人工确认",
  "settings.general.language": "界面语言",
  "settings.general.languageHint": "仅影响界面文案；词条内容的语言由 CLAUDE.md 契约决定。",
  "settings.models.slots": "模型槽",
  "settings.models.routing": "格式路由",
  "settings.models.routingHint": "不同格式自动路由到不同模型槽，无需手动选择。",
  "settings.resetToDefaults": "恢复为配置默认值",
  "settings.saved": "已保存",

  // ---- language switcher ----
  "lang.switch": "切换语言",
  "lang.zh": "中文",
  "lang.en": "English",

  // ---- onboarding ----
  "onboarding.welcome": "欢迎使用 LLM Wiki",
  "onboarding.topicLabel": "这个知识库是关于什么的？",
  "onboarding.topicPlaceholder": "例如：ConST326 智能压力校验仪",
  "onboarding.continue": "开始使用",
  "onboarding.skip": "稍后再说",
} as const;

export type MessageKey = keyof typeof zhCN;
