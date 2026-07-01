// Tests for the aitc core: the tolerant parser, the tool registry, think-tag
// stripping, and the agent loop driven by a mock generator. No model, no network.
#include "aitc/aitc.hpp"
#include <gtest/gtest.h>
#include <vector>

using namespace aitc;

// ── Tolerant parser ────────────────────────────────────────────────────────────
TEST(ParsePlan, PlainArray) {
    auto p = parsePlan(R"([{"name":"stock","arguments":{"id":7}}])");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
    EXPECT_EQ(p[0].args.value("id", 0), 7);
}

TEST(ParsePlan, SingleObjectIsAOneItemPlan) {
    auto p = parsePlan(R"({"name":"kpi","arguments":{}})");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "kpi");
}

TEST(ParsePlan, PlanWrapperObject) {
    auto p = parsePlan(R"({"plan":[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]})");
    ASSERT_EQ(p.size(), 2u);
    EXPECT_EQ(p[1].tool, "b");
}

TEST(ParsePlan, AcceptsToolAndArgKeyVariants) {
    EXPECT_EQ(parsePlan(R"({"tool":"x","parameters":{"q":"k"}})").at(0).tool, "x");
    EXPECT_EQ(parsePlan(R"({"name":"y","args":{"q":"k"}})").at(0).args.value("q",""), "k");
    EXPECT_EQ(parsePlan(R"({"name":"z","params":{"q":"k"}})").at(0).args.value("q",""), "k");
}

TEST(ParsePlan, IgnoresSurroundingProse) {
    auto p = parsePlan(R"(Sure! I'll call: [{"name":"t","arguments":{}}] now.)");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "t");
}

TEST(ParsePlan, RepairsStrayQuoteAfterNumber) {
    // {"limit":3"} — a stray quote after the number; repairJson recovers it.
    auto p = parsePlan(R"({"name":"t","arguments":{"limit":3"}})");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].args.value("limit", 0), 3);
}

TEST(ParsePlan, RepairsTrailingComma) {
    auto p = parsePlan(R"({"name":"t","arguments":{"a":1,}})");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].args.value("a", 0), 1);
}

TEST(ParsePlan, EmptyOnNoJson) {
    EXPECT_TRUE(parsePlan("just a plain text answer, no tools").empty());
}

TEST(ParsePlan, IgnoresBracesInsideStrings) {
    auto p = parsePlan(R"([{"name":"echo","arguments":{"text":"a } b ] c"}}])");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].args.value("text", ""), "a } b ] c");
}

TEST(ParsePlan, HonoursBackslashEscapeInString) {
    // An escaped quote inside a string value must not break brace-balancing
    // (exercises the `esc` branch in findJsonSpan, not just `inStr`).
    auto p = parsePlan(R"([{"name":"echo","arguments":{"text":"a \" b } c"}}])");
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].args.value("text", ""), "a \" b } c");
}

// ── Registry ───────────────────────────────────────────────────────────────────
TEST(ToolRegistry, DispatchKnownTool) {
    ToolRegistry reg;
    reg.add("hi", "greet", "", [](const nlohmann::json&) { return std::string("hello"); });
    EXPECT_TRUE(reg.has("hi"));
    EXPECT_EQ(reg.execute({"hi", {}}), "hello");
}

TEST(ToolRegistry, UnknownToolMessageNotThrow) {
    ToolRegistry reg;
    EXPECT_NE(reg.execute({"nope", {}}).find("Unknown tool"), std::string::npos);
}

TEST(ToolRegistry, ThrowingToolIsCaught) {
    ToolRegistry reg;
    reg.add("boom", "throws", "", [](const nlohmann::json&) -> std::string {
        throw std::runtime_error("kaboom");
    });
    EXPECT_NE(reg.execute({"boom", {}}).find("kaboom"), std::string::npos);
}

TEST(ToolRegistry, ArgsReachTool) {
    ToolRegistry reg;
    reg.add("sq", "square", R"({"n":<num>})", [](const nlohmann::json& a) {
        const int n = a.value("n", 0); return std::to_string(n * n);
    });
    EXPECT_EQ(reg.execute({"sq", {{"n", 9}}}), "81");
}

// ── Think-tag stripping ────────────────────────────────────────────────────────
TEST(SplitThinking, StripsThinkBlock) {
    auto s = splitThinking("<think>reasoning here</think>The answer is 42.");
    EXPECT_EQ(s.thinking, "reasoning here");
    EXPECT_EQ(s.answer, "The answer is 42.");
}

TEST(SplitThinking, NoTagsPassesThrough) {
    auto s = splitThinking("plain answer");
    EXPECT_TRUE(s.thinking.empty());
    EXPECT_EQ(s.answer, "plain answer");
}

TEST(SplitThinking, UnclosedThinkBecomesAnswerNotBlank) {
    // Truncated output (no </think>): surface the text as the answer, not blank it.
    auto s = splitThinking("<think>The answer is 42");
    EXPECT_EQ(s.answer, "The answer is 42");
}

TEST(SplitThinking, EmptyThinkBlockDoesNotLeakTags) {
    auto s = splitThinking("<think></think>");
    EXPECT_TRUE(s.answer.empty());        // must NOT echo the literal "<think></think>"
    EXPECT_TRUE(s.thinking.empty());
}

TEST(SplitThinking, CaseInsensitiveTags) {
    auto s = splitThinking("<THINK>reasoning</THINK>Answer.");
    EXPECT_EQ(s.thinking, "reasoning");
    EXPECT_EQ(s.answer, "Answer.");
}

// ── Agent loop (mock generator) ────────────────────────────────────────────────
namespace {
class Scripted : public IGenerator {
public:
    explicit Scripted(std::vector<std::string> s) : s_(std::move(s)) {}
    std::string generate(const std::string&) override {
        return i_ < s_.size() ? s_[i_++] : std::string("done");
    }
private:
    std::vector<std::string> s_; std::size_t i_ = 0;
};
}

TEST(RunAgent, ExecutesToolThenReturnsFinalAnswer) {
    ToolRegistry reg;
    reg.add("add", "add", R"({"a":<n>,"b":<n>})", [](const nlohmann::json& a) {
        return std::to_string(a.value("a", 0) + a.value("b", 0));
    });
    Scripted gen({ R"([{"name":"add","arguments":{"a":2,"b":3}}])", "The sum is 5." });
    auto r = runAgent(gen, reg, "2+3?");
    ASSERT_EQ(r.calls.size(), 1u);
    EXPECT_EQ(r.calls[0].tool, "add");
    EXPECT_EQ(r.answer, "The sum is 5.");
    EXPECT_EQ(r.rounds, 2);
}

TEST(RunAgent, PlainAnswerNoTools) {
    ToolRegistry reg;
    Scripted gen({ "Hello, I need no tools." });
    auto r = runAgent(gen, reg, "hi");
    EXPECT_TRUE(r.calls.empty());
    EXPECT_EQ(r.answer, "Hello, I need no tools.");
    EXPECT_EQ(r.rounds, 1);
}

TEST(RunAgent, ExhaustsRoundsThenSynthesisesFinalAnswer) {
    ToolRegistry reg;
    reg.add("loop", "loops", "", [](const nlohmann::json&) { return std::string("again"); });
    // 3 rounds keep tool-calling; the closing (4th) generation produces the final answer
    // from the gathered results — they must NOT be discarded.
    Scripted gen({
        R"([{"name":"loop","arguments":{}}])",
        R"([{"name":"loop","arguments":{}}])",
        R"([{"name":"loop","arguments":{}}])",
        "Final synthesised answer from results.",
    });
    auto r = runAgent(gen, reg, "go", 3);
    EXPECT_EQ(r.rounds, 3);                    // looped exactly maxRounds times
    EXPECT_EQ(r.calls.size(), 3u);             // one loop call per round
    EXPECT_EQ(r.answer, "Final synthesised answer from results.");
}

// ── Native tool-call protocols (parseToolCalls) ────────────────────────────────
TEST(Protocols, HammerJsonList) {
    auto p = parseToolCalls(R"([{"name":"stock","arguments":{"id":7}}])", ToolProtocol::Hammer);
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
    EXPECT_EQ(p[0].args.value("id", 0), 7);
}
TEST(Protocols, HammerGarbageIsEmpty) {
    EXPECT_TRUE(parseToolCalls("no calls here, just prose.", ToolProtocol::Hammer).empty());
}

TEST(Protocols, MistralToolCallsList) {
    auto p = parseToolCalls(R"([TOOL_CALLS] [{"name":"stock","arguments":{}}])", ToolProtocol::Mistral);
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
}
TEST(Protocols, MistralGarbageIsEmpty) {
    EXPECT_TRUE(parseToolCalls("[TOOL_CALLS] nothing valid", ToolProtocol::Mistral).empty());
}

TEST(Protocols, LlamaNameParameters) {
    auto p = parseToolCalls(R"({"name":"stock","parameters":{"id":7}})", ToolProtocol::Llama);
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
    EXPECT_EQ(p[0].args.value("id", 0), 7);   // "parameters" key variant is accepted
}
TEST(Protocols, LlamaGarbageIsEmpty) {
    EXPECT_TRUE(parseToolCalls("Environment: ipython — but no call.", ToolProtocol::Llama).empty());
}

TEST(Protocols, HermesToolCallTags) {
    auto p = parseToolCalls("<tool_call>\n{\"name\":\"stock\",\"arguments\":{}}\n</tool_call>",
                            ToolProtocol::Hermes);
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
}
TEST(Protocols, HermesGarbageIsEmpty) {
    EXPECT_TRUE(parseToolCalls("<tool_call> not json </tool_call>", ToolProtocol::Hermes).empty());
}

TEST(Protocols, LfmPythonBetweenTokens) {
    auto p = parseToolCalls(
        R"(<|tool_call_start|>[stock(id=7, tag="hi")]<|tool_call_end|>)", ToolProtocol::LfmPython);
    ASSERT_EQ(p.size(), 1u);
    EXPECT_EQ(p[0].tool, "stock");
    EXPECT_EQ(p[0].args.value("id", 0), 7);
    EXPECT_EQ(p[0].args.value("tag", ""), "hi");
}
TEST(Protocols, LfmPythonGarbageIsEmpty) {
    EXPECT_TRUE(parseToolCalls("just a plain sentence with no calls", ToolProtocol::LfmPython).empty());
}

TEST(ParsePyToolCalls, BarePythonListNoTokens) {
    auto p = parsePyToolCalls(R"([weather(city="Paris"), kpi()])");
    ASSERT_EQ(p.size(), 2u);
    EXPECT_EQ(p[0].tool, "weather");
    EXPECT_EQ(p[0].args.value("city", ""), "Paris");
    EXPECT_EQ(p[1].tool, "kpi");
    EXPECT_TRUE(p[1].args.empty());
}

TEST(ParsePyToolCalls, IsKnownPredicateFilters) {
    // A bare foo() in prose is not a real tool → predicate rejects it; falls back to plan (empty).
    auto p = parsePyToolCalls("please call foo() now",
                              [](const std::string& n) { return n == "stock"; });
    EXPECT_TRUE(p.empty());
}

// ── sanitizeAnswer ─────────────────────────────────────────────────────────────
TEST(SanitizeAnswer, StripsTrailingChatToken) {
    EXPECT_EQ(sanitizeAnswer("The answer is 42.<|im_end|>"), "The answer is 42.");
}
TEST(SanitizeAnswer, LeadingRoleTokenBecomesEmpty) {
    EXPECT_TRUE(sanitizeAnswer("<|eot_id|>next turn hallucination").empty());
}
TEST(SanitizeAnswer, StripsLeakedToolCallToken) {
    EXPECT_EQ(sanitizeAnswer("Done.<|tool_call_start|>[x()]"), "Done.");
}
TEST(SanitizeAnswer, RemovesCodeFences) {
    EXPECT_EQ(sanitizeAnswer("```\nplain\n```"), "plain");
}
TEST(SanitizeAnswer, CleanAnswerUnchanged) {
    EXPECT_EQ(sanitizeAnswer("A tidy plain answer."), "A tidy plain answer.");
}

// ── Agent-loop robustness ──────────────────────────────────────────────────────
TEST(RunAgent, EnforcesGlobalToolCallCap) {
    ToolRegistry reg;
    reg.add("loop", "loops", "", [](const nlohmann::json&) { return std::string("x"); });
    // A single plan asks for 10 loop calls; the cap (8) stops execution then synthesises.
    Scripted gen({
        R"([{"name":"loop","arguments":{"i":0}},{"name":"loop","arguments":{"i":1}},
            {"name":"loop","arguments":{"i":2}},{"name":"loop","arguments":{"i":3}},
            {"name":"loop","arguments":{"i":4}},{"name":"loop","arguments":{"i":5}},
            {"name":"loop","arguments":{"i":6}},{"name":"loop","arguments":{"i":7}},
            {"name":"loop","arguments":{"i":8}},{"name":"loop","arguments":{"i":9}}])",
        "Final answer after the cap.",
    });
    auto r = runAgent(gen, reg, "go");
    EXPECT_EQ(r.calls.size(), static_cast<std::size_t>(kMaxToolCalls));   // capped at 8
    EXPECT_EQ(r.answer, "Final answer after the cap.");
}

TEST(RunAgent, CachesDuplicateToolCall) {
    int executions = 0;
    ToolRegistry reg;
    reg.add("read", "reads", "", [&executions](const nlohmann::json&) {
        ++executions; return std::string("value");
    });
    // Two identical calls in one plan: executed once (cache hit on the second).
    Scripted gen({
        R"([{"name":"read","arguments":{"k":"a"}},{"name":"read","arguments":{"k":"a"}}])",
        "Done.",
    });
    auto r = runAgent(gen, reg, "go");
    EXPECT_EQ(r.calls.size(), 2u);      // both recorded
    EXPECT_EQ(executions, 1);           // but executed only once
}

TEST(RunAgent, CancellationStopsBeforeExecuting) {
    int executions = 0;
    ToolRegistry reg;
    reg.add("read", "reads", "", [&executions](const nlohmann::json&) {
        ++executions; return std::string("value");
    });
    Scripted gen({ R"([{"name":"read","arguments":{}}])", "should not reach" });
    auto r = runAgent(gen, reg, "go", 4, ToolProtocol::PlanJson, [] { return true; });
    EXPECT_EQ(executions, 0);                  // cancelled before any tool ran
    EXPECT_TRUE(r.calls.empty());
    EXPECT_EQ(r.answer, "Request cancelled.");
}

TEST(RunAgent, FiltersUnknownToolFromPlan) {
    ToolRegistry reg;
    reg.add("add", "add", "", [](const nlohmann::json& a) {
        return std::to_string(a.value("a", 0) + a.value("b", 0));
    });
    // Plan names a bogus tool alongside a real one; only the real one executes.
    Scripted gen({
        R"([{"name":"Gloves","arguments":{}},{"name":"add","arguments":{"a":2,"b":3}}])",
        "The sum is 5.",
    });
    auto r = runAgent(gen, reg, "go");
    ASSERT_EQ(r.calls.size(), 1u);
    EXPECT_EQ(r.calls[0].tool, "add");
    EXPECT_EQ(r.answer, "The sum is 5.");
}

TEST(RunAgent, RetriesOnBotchedFormatThenRecovers) {
    ToolRegistry reg;
    reg.add("add", "add", "", [](const nlohmann::json& a) {
        return std::to_string(a.value("a", 0) + a.value("b", 0));
    });
    // Round 1: an obviously-intended but unparseable call (has "tool"/"args", no balanced JSON).
    // The agent nudges once; round 2 is valid; round 3 is the final answer.
    Scripted gen({
        R"({"tool":"add","args":{"a":2,"b":3)",
        R"([{"name":"add","arguments":{"a":2,"b":3}}])",
        "The sum is 5.",
    });
    auto r = runAgent(gen, reg, "2+3?");
    ASSERT_EQ(r.calls.size(), 1u);
    EXPECT_EQ(r.calls[0].tool, "add");
    EXPECT_EQ(r.answer, "The sum is 5.");
    EXPECT_EQ(r.rounds, 3);              // round1 nudge, round2 exec, round3 final
}

// ── Per-protocol system prompt ─────────────────────────────────────────────────
TEST(SystemPrompt, NativeProtocolsEmitTheirScaffolding) {
    ToolRegistry reg;
    reg.add("stock", "Stock level", R"({"id":<n>})", [](const nlohmann::json&) { return std::string(); });
    EXPECT_NE(systemPrompt(reg, ToolProtocol::Hermes).find("<tools>"), std::string::npos);
    EXPECT_NE(systemPrompt(reg, ToolProtocol::Mistral).find("[AVAILABLE_TOOLS]"), std::string::npos);
    EXPECT_NE(systemPrompt(reg, ToolProtocol::Llama).find("Environment: ipython"), std::string::npos);
    EXPECT_NE(systemPrompt(reg, ToolProtocol::Hammer).find("[BEGIN OF TASK INSTRUCTION]"), std::string::npos);
    EXPECT_NE(systemPrompt(reg, ToolProtocol::LfmPython).find("<|tool_call_start|>"), std::string::npos);
    // PlanJson delegates to the model-agnostic prompt.
    EXPECT_EQ(systemPrompt(reg, ToolProtocol::PlanJson), systemPrompt(reg));
}
