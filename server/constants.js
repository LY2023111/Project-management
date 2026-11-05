/* 枚举常量（前后端共用的唯一事实来源） */
const PROJ_STATUS = ["筹备中","进行中","已上线","已验收","暂停"];
const MOD_STATUS  = ["未开始","开发中","测试中","试运行","已上线","无法上线"];
const MS_STATUS   = ["未开始","进行中","已完成"];
const MS_TYPES    = ["部署","测试","培训","上线","验收"];
const ISSUE_TYPES = ["问题","协调","Bug","需求"];
const ISSUE_STATUS= ["待处理","处理中","已完成","已解决"];
const PRIORITIES  = ["高","中","低"];
const PHASE_STATUS = ["未开始","进行中","已完成"];
const TASK_STATUS  = ["未开始","进行中","已完成","已取消"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* 模块交付附件类型；前三项为上线/验收必备材料（前端按此做齐备度检查） */
const FILE_CATEGORIES = ["培训签到单","上线确认单","模块验收报告","测试报告","操作手册","其他"];
const REQUIRED_FILE_CATEGORIES = ["培训签到单","上线确认单","模块验收报告"];

module.exports = {
  PROJ_STATUS, MOD_STATUS, MS_STATUS, MS_TYPES, ISSUE_TYPES, ISSUE_STATUS,
  PRIORITIES, PHASE_STATUS, TASK_STATUS, DATE_RE, FILE_CATEGORIES, REQUIRED_FILE_CATEGORIES,
};
