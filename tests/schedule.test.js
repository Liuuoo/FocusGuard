const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getDaySchedule,
  normalizeDateKey,
  normalizeSchoolBreaks,
  validateSchoolBreaks
} = require("../src/schedule");

function localNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

test("周六日自动使用休息日额度", () => {
  const result = getDaySchedule(localNoon(2026, 8, 15));

  assert.equal(result.dayType, "weekend");
  assert.equal(result.dayLabel, "休息日");
  assert.equal(result.dayReason, "周末");
});

test("暑假工作日使用休息日额度", () => {
  const result = getDaySchedule(localNoon(2026, 8, 14), {
    summerStart: "2026-07-01",
    summerEnd: "2026-08-31"
  });

  assert.equal(result.dayType, "weekend");
  assert.equal(result.dayReason, "暑假");
});

test("跨年寒假可以覆盖下一年的工作日", () => {
  const result = getDaySchedule(localNoon(2027, 1, 15), {
    winterStart: "2026-12-25",
    winterEnd: "2027-02-15"
  });

  assert.equal(result.dayType, "weekend");
  assert.equal(result.dayReason, "寒假");
});

test("假期范围外的工作日仍使用工作日额度", () => {
  const result = getDaySchedule(localNoon(2026, 9, 1), {
    summerStart: "2026-07-01",
    summerEnd: "2026-08-31"
  });

  assert.equal(result.dayType, "weekday");
  assert.equal(result.dayLabel, "工作日");
  assert.equal(result.dayReason, "工作日");
});

test("假期日期会校验真实日期和完整范围", () => {
  assert.equal(normalizeDateKey("2026-02-30"), "");
  assert.equal(validateSchoolBreaks({ winterStart: "2026-01-10" }), "寒假需要同时填写开始和结束日期");
  assert.equal(validateSchoolBreaks({ summerStart: "2026-08-31", summerEnd: "2026-07-01" }), "暑假开始日期不能晚于结束日期");
  assert.equal(validateSchoolBreaks({ winterStart: "2026-01-20", winterEnd: "2026-02-10" }), "");
});

test("旧配置或空配置会得到稳定的假期结构", () => {
  assert.deepEqual(normalizeSchoolBreaks(), {
    winterStart: "",
    winterEnd: "",
    summerStart: "",
    summerEnd: ""
  });
});
