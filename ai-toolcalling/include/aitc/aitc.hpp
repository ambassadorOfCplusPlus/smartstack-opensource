// aitc — local-LLM tool-calling for C++ (header-only).
//
// Bring your own MODEL (implement IGenerator) and your own TOOLS (register
// callbacks in a ToolRegistry); aitc gives you the rest: a tolerant parser for
// the many shapes small models emit, a deterministic agent loop (model proposes
// tool calls → YOU execute → feed results back), think-tag stripping, and a
// system-prompt builder. No model, no network, no framework baked in — the core
// is pure C++ + nlohmann/json and is testable with a mock generator.
//
// Extracted from the SmartStock project; the tolerant parser is battle-tested
// across a 13-model local-LLM benchmark (see docs/RESEARCH.md). MIT licensed.
#pragma once
#include <nlohmann/json.hpp>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include <cctype>
#include <cstddef>
#include <exception>

namespace aitc {

// ── Core types ─────────────────────────────────────────────────────────────────
struct ToolCall {
    std::string tool;          // tool name the model asked for
    nlohmann::json args;       // arguments object (may be empty {})
};

// A tool callback: receives the parsed args object, returns a text result that is
// fed back to the model. Keep results compact — they go into the next prompt.
using ToolFn = std::function<std::string(const nlohmann::json& args)>;

struct Tool {
    std::string name;          // stable id the model calls
    std::string description;   // one line — shown in the system prompt
    std::string params;        // human arg hint, e.g. {"city": "..."} — for the prompt
    ToolFn fn;                 // the implementation
};

// ── Tool platform: register your tools here ────────────────────────────────────
// This is the plugin point. A developer does:
//   ToolRegistry reg;
//   reg.add({"weather", "Weather for a city", R"({"city":"<name>"})",
//            [](const json& a){ return lookup(a.value("city","")); }});
class ToolRegistry {
public:
    ToolRegistry& add(Tool t) { m_[t.name] = std::move(t); return *this; }
    ToolRegistry& add(std::string name, std::string description,
                      std::string params, ToolFn fn) {
        return add(Tool{std::move(name), std::move(description),
                        std::move(params), std::move(fn)});
    }
    bool has(const std::string& name) const { return m_.count(name) > 0; }
    const Tool* find(const std::string& name) const {
        auto it = m_.find(name);
        return it == m_.end() ? nullptr : &it->second;
    }
    std::vector<const Tool*> tools() const {
        std::vector<const Tool*> v;
        for (const auto& [k, t] : m_) v.push_back(&t);
        return v;
    }
    // Dispatch a parsed call. Unknown tool / throwing tool → a readable message
    // the model can recover from (never throws out of the agent loop).
    std::string execute(const ToolCall& call) const {
        const Tool* t = find(call.tool);
        if (!t) return "Unknown tool \"" + call.tool + "\".";
        try { return t->fn(call.args); }
        catch (const std::exception& e) { return std::string("Tool error: ") + e.what(); }
        catch (...) { return "Tool error (unknown)."; }
    }
private:
    std::map<std::string, Tool> m_;
};

// ── Bring your own model ───────────────────────────────────────────────────────
// Implement this over llama.cpp, an HTTP endpoint, or anything else. `generate`
// takes a full prompt and returns the completion text.
class IGenerator {
public:
    virtual ~IGenerator() = default;
    virtual std::string generate(const std::string& prompt) = 0;
};

// ── Tolerant parsing (ported from SmartStock, verbatim logic) ───────────────────
// Map one JSON element to a call, accepting the key variants small models emit:
// tool|name for the name, args|arguments|parameters|params for the arguments.
inline std::optional<ToolCall> toolFromJson(const nlohmann::json& js) {
    if (!js.is_object()) return std::nullopt;
    std::string tool;
    if (js.contains("tool") && js["tool"].is_string()) tool = js["tool"].get<std::string>();
    else if (js.contains("name") && js["name"].is_string()) tool = js["name"].get<std::string>();
    if (tool.empty()) return std::nullopt;
    nlohmann::json a = nlohmann::json::object();
    for (const char* k : {"args", "arguments", "parameters", "params"})
        if (js.contains(k) && js[k].is_object()) { a = js[k]; break; }
    return ToolCall{tool, a};
}

// First balanced JSON literal ({…} or […]) in text, from `from`. Returns [b,e) or
// {npos,npos}. Skips braces inside strings (honours escaping).
inline std::pair<std::size_t, std::size_t> findJsonSpan(const std::string& out, std::size_t from) {
    for (std::size_t i = from; i < out.size(); ++i) {
        if (out[i] != '{' && out[i] != '[') continue;
        int depth = 0; bool inStr = false, esc = false;
        std::size_t j = i;
        for (; j < out.size(); ++j) {
            char ch = out[j];
            if (inStr) {
                if (esc) esc = false;
                else if (ch == '\\') esc = true;
                else if (ch == '"') inStr = false;
            } else if (ch == '"') inStr = true;
            else if (ch == '{' || ch == '[') ++depth;
            else if (ch == '}' || ch == ']') { --depth; if (depth == 0) { ++j; break; } }
        }
        if (depth == 0) return {i, j};
    }
    return {std::string::npos, std::string::npos};
}

// Light repair of frequent LLM-JSON slips: (1) stray quote right after a number
// before }/]/, (some models emit {"limit":3"}); (2) trailing comma before }/].
// Strings are left untouched.
inline std::string repairJson(const std::string& s) {
    std::string out; out.reserve(s.size());
    bool inStr = false, esc = false;
    for (std::size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (inStr) {
            out += c;
            if (esc) esc = false; else if (c == '\\') esc = true; else if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') {
            if (!out.empty() && std::isdigit(static_cast<unsigned char>(out.back()))) {
                std::size_t j = i + 1;
                while (j < s.size() && std::isspace(static_cast<unsigned char>(s[j]))) ++j;
                if (j < s.size() && (s[j] == '}' || s[j] == ']' || s[j] == ',')) continue;
            }
            inStr = true; out += c;
        } else if (c == ',') {
            std::size_t j = i + 1;
            while (j < s.size() && std::isspace(static_cast<unsigned char>(s[j]))) ++j;
            if (j < s.size() && (s[j] == '}' || s[j] == ']')) continue;
            out += c;
        } else out += c;
    }
    return out;
}

// Parse a "plan" of tool calls out of free-form model text. Accepts an array
// [{...}], an object {"plan":[...]}, or a single {...} call. Scans every balanced
// JSON literal; if none parse, repairs the whole string and scans once more.
inline std::vector<ToolCall> parsePlan(const std::string& out) {
    auto scan = [](const std::string& s) -> std::vector<ToolCall> {
        std::size_t from = 0;
        while (true) {
            auto [b, e] = findJsonSpan(s, from);
            if (b == std::string::npos) return {};
            try {
                auto js = nlohmann::json::parse(s.substr(b, e - b));
                std::vector<ToolCall> plan;
                if (js.is_array()) {
                    for (const auto& el : js) if (auto c = toolFromJson(el)) plan.push_back(*c);
                } else if (js.is_object() && js.contains("plan") && js["plan"].is_array()) {
                    for (const auto& el : js["plan"]) if (auto c = toolFromJson(el)) plan.push_back(*c);
                } else if (auto c = toolFromJson(js)) {
                    plan.push_back(*c);
                }
                if (!plan.empty()) return plan;
            } catch (...) {}
            from = b + 1;
        }
    };
    auto plan = scan(out);
    if (plan.empty()) {
        const std::string fixed = repairJson(out);
        if (fixed != out) plan = scan(fixed);
    }
    return plan;
}

// ── Think-tag stripping ────────────────────────────────────────────────────────
// Hybrid-thinking models (Qwen3, Gemma) wrap reasoning in <think>…</think>
// (or <thinking>). Split it from the user-facing answer.
struct ThinkSplit { std::string thinking; std::string answer; };

namespace detail {
// ASCII lowercase. Preserves byte positions (UTF-8 multibyte bytes are >=0x80, never
// touched), so offsets computed on the lowered copy are valid in the original.
inline std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}
inline std::string trim(const std::string& s) {
    const char* ws = " \t\r\n";
    const auto a = s.find_first_not_of(ws);
    if (a == std::string::npos) return std::string();
    const auto b = s.find_last_not_of(ws);
    return s.substr(a, b - a + 1);
}
} // namespace detail

inline ThinkSplit splitThinking(const std::string& out) {
    ThinkSplit r;
    // Case-insensitive: match on a lowercased copy whose byte offsets stay valid (above).
    const std::string lo = detail::lower(out);
    std::size_t open = lo.find("<think>");
    std::size_t openLen = 7;
    if (open == std::string::npos) { open = lo.find("<thinking>"); openLen = 10; }
    if (open == std::string::npos) { r.answer = detail::trim(out); return r; }

    const std::size_t innerStart = open + openLen;
    std::size_t close = lo.find("</think>", innerStart);
    std::size_t closeLen = 8;
    if (close == std::string::npos) { close = lo.find("</thinking>", innerStart); closeLen = 11; }
    if (close == std::string::npos) {
        // Unclosed <think> (output truncated by token/time limit): do NOT blank the answer
        // or hide everything as "thinking" — surface what's there as the answer, minus the
        // literal tag. Otherwise the caller gets an empty reply (common small-model failure).
        r.answer = detail::trim(out.substr(0, open) + out.substr(innerStart));
        return r;
    }
    r.thinking = detail::trim(out.substr(innerStart, close - innerStart));
    r.answer = detail::trim(out.substr(0, open) + out.substr(close + closeLen));
    return r;
}

// ── System prompt ──────────────────────────────────────────────────────────────
// Lists the registered tools, the call format (a JSON plan), and anti-hallucination
// rules. Generic — no domain knowledge.
inline std::string systemPrompt(const ToolRegistry& reg) {
    std::string p =
        "You are an assistant that can call tools to answer questions about data.\n"
        "To use tools, reply with a JSON array of calls and nothing else:\n"
        "  [{\"name\":\"<tool>\",\"arguments\":{...}}]\n"
        "(the wrapped form {\"plan\":[ ... ]} is also accepted.)\n"
        "You may request several tools at once. After you receive the results, "
        "reply with the final answer in plain text (no JSON).\n"
        "Do NOT invent numbers — only state values returned by tools.\n\n"
        "Available tools:\n";
    for (const Tool* t : reg.tools()) {
        p += "- " + t->name + ": " + t->description;
        if (!t->params.empty()) p += "  args: " + t->params;
        p += "\n";
    }
    return p;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
// Plan protocol (the most robust across weak models — see docs/RESEARCH.md): the
// model proposes tool calls as JSON, WE execute them deterministically against the
// registry and feed results back, until the model returns a plain-text answer or
// maxRounds is reached. The model never executes anything itself.
struct AgentResult {
    std::string answer;             // final plain-text answer
    std::vector<ToolCall> calls;    // every call executed, in order
    int rounds = 0;                 // generation rounds used
};

inline AgentResult runAgent(IGenerator& gen, const ToolRegistry& reg,
                            const std::string& question, int maxRounds = 4) {
    AgentResult res;
    std::string prompt = systemPrompt(reg) + "\nUser: " + question + "\nAssistant:";
    for (int round = 1; round <= maxRounds; ++round) {
        res.rounds = round;
        const std::string raw = gen.generate(prompt);
        const std::string answer = splitThinking(raw).answer;
        std::vector<ToolCall> plan = parsePlan(answer);
        if (plan.empty()) {                 // no tool calls → final answer
            res.answer = answer;
            return res;
        }
        std::string feedback = "\nTool results:\n";
        for (const auto& call : plan) {
            res.calls.push_back(call);
            feedback += call.tool + " => " + reg.execute(call) + "\n";
        }
        // Append the think-STRIPPED answer (keeps the plan, drops the model's own <think>
        // tokens so reasoning doesn't accumulate in the growing context) + tool results.
        prompt += answer + feedback + "\nAssistant:";
    }
    // Rounds exhausted while the model kept tool-calling: do ONE closing generation to
    // synthesise a plain-text answer from the gathered results — don't discard them.
    const std::string finalRaw = gen.generate(
        prompt + " Now give the final answer in plain text, without any tool calls.");
    res.answer = splitThinking(finalRaw).answer;
    return res;
}

} // namespace aitc
