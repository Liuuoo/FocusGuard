const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const SCHOOL_BREAK_FIELDS = [
  "winterStart",
  "winterEnd",
  "summerStart",
  "summerEnd"
];

function normalizeDateKey(value) {
  const key = String(value || "").trim();
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) return "";

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    return "";
  }
  return key;
}

function normalizeSchoolBreaks(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(SCHOOL_BREAK_FIELDS.map((field) => [
    field,
    normalizeDateKey(source[field])
  ]));
}

function validateSchoolBreaks(value = {}) {
  const breaks = normalizeSchoolBreaks(value);
  const ranges = [
    ["寒假", breaks.winterStart, breaks.winterEnd],
    ["暑假", breaks.summerStart, breaks.summerEnd]
  ];

  for (const [label, start, end] of ranges) {
    const rawStart = String(value?.[label === "寒假" ? "winterStart" : "summerStart"] || "").trim();
    const rawEnd = String(value?.[label === "寒假" ? "winterEnd" : "summerEnd"] || "").trim();
    if ((rawStart && !start) || (rawEnd && !end)) return `${label}日期无效`;
    if (Boolean(start) !== Boolean(end)) return `${label}需要同时填写开始和结束日期`;
    if (start && end && start > end) return `${label}开始日期不能晚于结束日期`;
  }
  return "";
}

function dateKeyFromTimestamp(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isDateInRange(dateKey, start, end) {
  return Boolean(start && end && start <= dateKey && dateKey <= end);
}

function getDaySchedule(ms = Date.now(), schoolBreaks = {}) {
  const date = new Date(ms);
  const dateKey = dateKeyFromTimestamp(ms);
  const breaks = normalizeSchoolBreaks(schoolBreaks);

  if (date.getDay() === 0 || date.getDay() === 6) {
    return {
      dayType: "weekend",
      dayLabel: "休息日",
      dayReason: "周末",
      date: dateKey
    };
  }

  if (isDateInRange(dateKey, breaks.winterStart, breaks.winterEnd)) {
    return {
      dayType: "weekend",
      dayLabel: "休息日",
      dayReason: "寒假",
      date: dateKey
    };
  }

  if (isDateInRange(dateKey, breaks.summerStart, breaks.summerEnd)) {
    return {
      dayType: "weekend",
      dayLabel: "休息日",
      dayReason: "暑假",
      date: dateKey
    };
  }

  return {
    dayType: "weekday",
    dayLabel: "工作日",
    dayReason: "工作日",
    date: dateKey
  };
}

module.exports = {
  dateKeyFromTimestamp,
  getDaySchedule,
  normalizeDateKey,
  normalizeSchoolBreaks,
  validateSchoolBreaks
};
