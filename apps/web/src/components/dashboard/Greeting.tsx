/**
 * 5-21 P0 — 问候 + 日期 + 系统状态。
 */
interface GreetingProps {
  userName?: string;
}

function timeOfDayLabel(hour: number): string {
  if (hour < 5) return "凌晨好";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function Greeting({ userName }: GreetingProps) {
  const now = new Date();
  const hello = timeOfDayLabel(now.getHours());
  const dateLabel = `${WEEKDAYS[now.getDay()]} · ${now.getMonth() + 1}月${now.getDate()}日`;

  return (
    <header className="mb-5">
      <h1 className="text-2xl font-bold text-gray-900">
        {hello}{userName ? <>，<span className="text-blue-600">{userName}</span></> : ""}
      </h1>
      <p className="text-sm text-gray-500 mt-1 flex items-center gap-2">
        <span>{dateLabel}</span>
        <span className="text-gray-300">·</span>
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span>系统正常</span>
        </span>
      </p>
    </header>
  );
}
