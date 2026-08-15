const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppClassificationPrompt,
  classifyAppWithAI,
  classifyKnownApp,
  heuristicClassifyApp,
  normalizeAppClassification,
  parseDuckDuckGoResults
} = require("../src/app-classifier");

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => ""
  };
}

function aiResponse(result) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(result) } }]
  });
}

test("OBS 安装器被识别为工具且不计入娱乐", () => {
  const result = classifyKnownApp({
    exe: "obs-studio-32.2.1-windows-x64-installer.exe",
    processName: "obs-studio-32.2.1-windows-x64-installer",
    title: "OBS Studio 32.2.1 Setup"
  });

  assert.equal(result.category, "tool");
  assert.equal(result.isEntertainment, false);
  assert.equal(result.needsResearch, false);
});

test("OBS 正式程序被识别为内容制作工具", () => {
  const result = classifyKnownApp({
    exe: "obs64.exe",
    processName: "obs64",
    title: "OBS Studio"
  });

  assert.equal(result.category, "tool");
  assert.equal(result.isEntertainment, false);
});

test("游戏仍然被本地规则识别为娱乐", () => {
  const result = heuristicClassifyApp({
    exe: "taptap.exe",
    processName: "taptap",
    title: "TapTap"
  });

  assert.equal(result.category, "entertainment");
  assert.equal(result.isEntertainment, true);
});

test("未知分类不会在资料不足时被强制归为娱乐", () => {
  const result = normalizeAppClassification({
    category: "entertainment",
    is_entertainment: true,
    confidence: 0.2,
    needs_research: true,
    reason: "无法确认"
  });

  assert.equal(result.category, "unknown");
  assert.equal(result.isEntertainment, false);
  assert.equal(result.needsResearch, true);
});

test("软件提示词明确区分内容消费和内容制作", () => {
  const prompt = buildAppClassificationPrompt({
    exe: "obs64.exe",
    processName: "obs64",
    title: "OBS Studio"
  });

  assert.match(prompt, /不要因为软件能够制作娱乐内容/);
  assert.match(prompt, /安装程序、更新程序、卸载程序/);
  assert.match(prompt, /needs_research=true/);
  assert.match(prompt, /is_entertainment/);
});

test("未知软件会先检索，再进行第二次 AI 判定", async () => {
  let aiCalls = 0;
  let searchCalls = 0;
  const result = await classifyAppWithAI(
    { exe: "mystery-player.exe", processName: "mystery-player", title: "Mystery Player" },
    {
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      fetchImpl: async (_url, options) => {
        aiCalls += 1;
        const body = JSON.parse(options.body);
        if (aiCalls === 2) assert.match(body.messages[1].content, /联网检索结果/);
        return aiCalls === 1
          ? aiResponse({
            category: "unknown",
            is_entertainment: false,
            confidence: 0.2,
            needs_research: true,
            research_query: "Mystery Player official purpose",
            reason: "产品身份不明确"
          })
          : aiResponse({
            category: "tool",
            is_entertainment: false,
            confidence: 0.92,
            needs_research: false,
            reason: "官方资料显示这是生产力工具"
          });
      },
      searchImpl: async (query) => {
        searchCalls += 1;
        assert.equal(query, "Mystery Player official purpose");
        return [{
          title: "Mystery Player official",
          url: "https://example.com/mystery-player",
          snippet: "A productivity utility."
        }];
      }
    }
  );

  assert.equal(aiCalls, 2);
  assert.equal(searchCalls, 1);
  assert.equal(result.category, "tool");
  assert.equal(result.isEntertainment, false);
  assert.equal(result.needsResearch, false);
});

test("可以解析联网搜索摘要", () => {
  const html = [
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftool">Example Tool</a>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftool">A <b>tool</b> for work.</a>'
  ].join("\n");
  const results = parseDuckDuckGoResults(html);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/tool");
  assert.equal(results[0].snippet, "A tool for work.");
});
