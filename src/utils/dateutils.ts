import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
// 导入中文包以正确显示星期
dayjs.locale('zh-cn')

export function formatSmartTime(dateInput: string | number | Date) {
  const target = dayjs(dateInput)
  const now = dayjs()

  // 1. 判断是否是今天
  if (target.isSame(now, 'day')) {
    return target.format('HH:mm') // 显示时间，例如 14:30
  }

  // 2. 判断是否是今年同一周（基于dayjs的isSame(..., 'week')）
  if (target.isSame(now, 'week')) {
    return target.format('dddd') // 显示星期几，例如 星期一
  }

  // 3. 判断是否是今年
  if (target.isSame(now, 'year')) {
    return target.format('MM-DD') // 显示月日，例如 05-20
  }
  // 4. 跨年则显示完整年月日
  return target.format('YYYY-MM-DD')
}
