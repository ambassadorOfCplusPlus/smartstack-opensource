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
