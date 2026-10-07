/**
 * 现场实测口径的权威种子数据 —— 本地开发与线上构建读的是同一份文件，
 * 不存在「换台机器交接编号/班次就变」的副本。
 *
 * 值班交接样例按「交接编号 + 班次」生成：交接编号 DUTY-YYYYMMDD-白班1/夜班2，
 * 班组按现场花名册轮转（见 duty-domain.expectedTeam）。
 * 渗漏处置按发现日期倒排补录；缺值一律留空字符串，不拿默认值顶。
 */
import type { EntryRow } from './types'
import {
  SHIFT_DAY,
  SHIFT_NIGHT,
  STATUS_DONE,
  STATUS_HANDOVER,
  STATUS_LEGACY,
  STATUS_PENDING,
  dutyCode,
  expectedTeam,
  rosterOf,
} from './duty-domain'

type DutySeedSpec = {
  date: string
  shift: typeof SHIFT_DAY | typeof SHIFT_NIGHT
  /** 值班人员；交接人员与交接事项为空表示该班次尚未交班。 */
  onDuty: string
  handoverPerson?: string
  handoverNote?: string
  legacy?: string
  status: typeof STATUS_PENDING | typeof STATUS_HANDOVER | typeof STATUS_DONE | typeof STATUS_LEGACY
}

const DUTY_SPECS: DutySeedSpec[] = [
  { date: '2026-10-01', shift: SHIFT_DAY, onDuty: '陈岩', handoverPerson: '高航', handoverNote: '各舱室巡视正常，3号排水泵坑水位偏高，已加密观测。', status: STATUS_DONE },
  { date: '2026-10-01', shift: SHIFT_NIGHT, onDuty: '林远航', handoverPerson: '赵启明', handoverNote: '夜间通风机组轮换运行正常，无报警。', status: STATUS_DONE },
  { date: '2026-10-02', shift: SHIFT_DAY, onDuty: '赵启明', handoverPerson: '何静', handoverNote: '消防联动周测完成，探测器在线率100%。', status: STATUS_DONE },
  { date: '2026-10-02', shift: SHIFT_NIGHT, onDuty: '周野', handoverPerson: '孙鹏', handoverNote: 'K1+520电力舱施工缝渗水滴水，已挂跟踪观察牌。', status: STATUS_DONE },
  { date: '2026-10-03', shift: SHIFT_DAY, onDuty: '郭敏', handoverPerson: '周野', handoverNote: '施工缝渗漏点位完成导流槽布设，移交二班夜班盯守。', status: STATUS_DONE },
  { date: '2026-10-03', shift: SHIFT_NIGHT, onDuty: '高航', handoverPerson: '宋洁', handoverNote: '集水坑启泵正常，照明回路抽检无异常。', status: STATUS_DONE },
  {
    date: '2026-10-04',
    shift: SHIFT_DAY,
    onDuty: '宋洁',
    handoverPerson: '陈岩',
    handoverNote: '3号排水泵液位计读数跳变，已停用并挂牌。',
    legacy: '3号排水泵坑液位计故障，读数失真，需更换后复核启泵水位。',
    status: STATUS_LEGACY,
  },
  { date: '2026-10-04', shift: SHIFT_NIGHT, onDuty: '何静', handoverPerson: '林远航', handoverNote: '液位计故障期间改为每小时人工量测水位，记录已附台账。', status: STATUS_DONE },
  { date: '2026-10-05', shift: SHIFT_DAY, onDuty: '林远航', handoverPerson: '赵启明', handoverNote: 'K2+800伸缩缝新见渗水点，已开渗漏处置单LEAK-0009。', status: STATUS_DONE },
  { date: '2026-10-05', shift: SHIFT_NIGHT, onDuty: '孙鹏', status: STATUS_HANDOVER },
  { date: '2026-10-06', shift: SHIFT_DAY, onDuty: '周野', handoverPerson: '郭敏', handoverNote: '液位计更换完成，启泵/停泵水位实测复核合格，遗留事项闭环。', status: STATUS_DONE },
  { date: '2026-10-06', shift: SHIFT_NIGHT, onDuty: '陈岩', handoverPerson: '高航', handoverNote: '各舱室夜间巡视正常，LEAK-0009处置中。', status: STATUS_DONE },
  { date: '2026-10-07', shift: SHIFT_DAY, onDuty: '高航', status: STATUS_PENDING },
  { date: '2026-10-07', shift: SHIFT_NIGHT, onDuty: '宋洁', status: STATUS_PENDING },
]

/** 由规格确定性地生成交接记录：同一份规格在任何环境生成的结果完全一致。 */
export function measuredDutyRows(): EntryRow[] {
  return DUTY_SPECS.map((spec, index) => {
    const team = expectedTeam(spec.date, spec.shift)
    const handoverPerson = spec.handoverPerson ?? ''
    // 实测数据自检：交接人员必须属于当班班组花名册，否则生成即报错。
    if (handoverPerson && !rosterOf(team).includes(handoverPerson)) {
      throw new Error(`实测种子 ${spec.date} ${spec.shift} 的交接人员 ${handoverPerson} 不属于 ${team}`)
    }
    const legacy = spec.legacy ?? ''
    const status = legacy ? STATUS_LEGACY : spec.status
    return {
      id: index + 1,
      status,
      pending: status !== STATUS_DONE,
      abnormal: status === STATUS_LEGACY,
      交接编号: dutyCode(spec.date, spec.shift),
      值班班组: team,
      值班日期: spec.date,
      班次: spec.shift,
      班次来源: '实测',
      值班人员: spec.onDuty,
      交接事项: spec.handoverNote ?? '',
      遗留事项: legacy,
      交接人员: handoverPerson,
      交接状态: status,
    }
  })
}

/**
 * 保养台账：最后一条由 2026-10-04 白班遗留事项（DUTY-20261004-1）同步登记，
 * 两边「来源交接编号」对齐。未完工的记录完工日期/更换部件按实测留空。
 */
export function measuredMaintenanceRows(): EntryRow[] {
  return [
    {
      id: 1,
      status: '已完工',
      pending: false,
      abnormal: false,
      检修编号: 'MAIN-0010',
      检修对象: '1#通风机组',
      检修类别: '日常保养',
      检修班组: '综合运维一班',
      计划工期: '2026-09-24 至 2026-09-24',
      完工日期: '2026-09-24',
      更换部件: '传动皮带',
      检修状态: '已完工',
      来源交接编号: '',
    },
    {
      id: 2,
      status: '检修中',
      pending: true,
      abnormal: false,
      检修编号: 'MAIN-0012',
      检修对象: 'K1+520电力舱排水泵',
      检修类别: '故障检修',
      检修班组: '综合运维三班',
      计划工期: '2026-10-03 至 2026-10-08',
      完工日期: '',
      更换部件: '',
      检修状态: '检修中',
      来源交接编号: '',
    },
    {
      id: 3,
      status: '已完工',
      pending: false,
      abnormal: false,
      检修编号: 'MAIN-0011',
      检修对象: '3号排水泵液位计',
      检修类别: '故障检修',
      检修班组: '综合运维一班',
      计划工期: '2026-10-04 至 2026-10-06',
      完工日期: '2026-10-06',
      更换部件: '投入式液位计',
      检修状态: '已完工',
      来源交接编号: 'DUTY-20261004-1',
    },
    {
      id: 4,
      status: '待开工',
      pending: true,
      abnormal: false,
      检修编号: 'MAIN-0013',
      检修对象: 'K2+800综合舱伸缩缝封堵',
      检修类别: '专项检修',
      检修班组: '综合运维二班',
      计划工期: '2026-10-08 至 2026-10-10',
      完工日期: '',
      更换部件: '',
      检修状态: '待开工',
      来源交接编号: '',
    },
  ]
}

/** 渗漏处置：按发现日期倒排补录，处置中的记录完工日期留空（实测没有就是没有）。 */
export function measuredLeakRows(): EntryRow[] {
  return [
    {
      id: 1,
      status: '处置中',
      pending: true,
      abnormal: false,
      处置编号: 'LEAK-0009',
      渗漏点位: 'K2+800综合舱伸缩缝',
      渗漏程度: '轻度',
      处置方式: '嵌缝注浆',
      处置班组: '综合运维二班',
      发现日期: '2026-10-05',
      完工日期: '',
      处置状态: '处置中',
    },
    {
      id: 2,
      status: '已完工',
      pending: false,
      abnormal: false,
      处置编号: 'LEAK-0008',
      渗漏点位: 'K1+520电力舱施工缝',
      渗漏程度: '中度',
      处置方式: '导流槽加骑缝注浆',
      处置班组: '综合运维三班',
      发现日期: '2026-10-03',
      完工日期: '2026-10-06',
      处置状态: '已完工',
    },
    {
      id: 3,
      status: '已完工',
      pending: false,
      abnormal: false,
      处置编号: 'LEAK-0007',
      渗漏点位: 'K0+960燃气舱管壁',
      渗漏程度: '轻度',
      处置方式: '表面封闭',
      处置班组: '综合运维一班',
      发现日期: '2026-09-28',
      完工日期: '2026-09-30',
      处置状态: '已完工',
    },
    {
      id: 4,
      status: '已完工',
      pending: false,
      abnormal: false,
      处置编号: 'LEAK-0006',
      渗漏点位: 'K0+320综合舱变形缝',
      渗漏程度: '中度',
      处置方式: '骑缝注浆',
      处置班组: '综合运维二班',
      发现日期: '2026-09-21',
      完工日期: '2026-09-25',
      处置状态: '已完工',
    },
  ]
}
