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
#include <algorithm>
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

// Tool-call wire protocol. PlanJson is the model-agnostic default (a JSON plan
// {"plan":[…]} — the most robust across weak models). The rest are the NATIVE
// formats families were trained on (using them can be more reliable for that
// family): LfmPython (LFM2 / Llama 3.2 — a python-style [func(arg=val)] list between
// <|tool_call_start|>/<|tool_call_end|> tokens), Hammer (xLAM structured JSON list),
// Mistral ([AVAILABLE_TOOLS]/[TOOL_CALLS]), Llama (Environment: ipython + JSON
// {"name","parameters"}), Hermes (<tools>/<tool_call> tags). The scaffolding differs
// per protocol; parsing is tolerant and shared (see parseToolCalls). No domain
// knowledge — mapping a concrete model id to a protocol is the caller's job.
enum class ToolProtocol { PlanJson, LfmPython, Hammer, Mistral, Llama, Hermes };

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

// ── Native LFM2 protocol: python-style tool calls (pure string parse, no Python) ──
namespace detail {
// Truncate to `cap` BYTES without splitting a UTF-8 codepoint (walk back off any
// continuation bytes 0b10xxxxxx), appending `suffix` only when actually cut.
inline std::string utf8Truncate(const std::string& s, std::size_t cap, const std::string& suffix) {
    if (s.size() <= cap) return s;
    std::size_t cut = cap;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) --cut;
    return s.substr(0, cut) + suffix;
}

// One python argument value → JSON (quoted string / number / bool); bare word → string.
inline nlohmann::json pyValue(const std::string& raw) {
    const std::string v = trim(raw);
    if (v.size() >= 2 && (v.front() == '"' || v.front() == '\'') && v.back() == v.front()) {
        const std::string inner = v.substr(1, v.size() - 2);
        std::string s;
        for (std::size_t i = 0; i < inner.size(); ++i) {
            if (inner[i] == '\\' && i + 1 < inner.size()) {
                const char n = inner[++i];
                s += (n == 'n') ? '\n' : (n == 't') ? '\t' : n;
            } else s += inner[i];
        }
        return s;
    }
    if (v == "true" || v == "True")   return true;
    if (v == "false" || v == "False") return false;
    try {
        std::size_t pos = 0;
        if (v.find_first_of(".eE") == std::string::npos) {
            const long long n = std::stoll(v, &pos);
            if (pos == v.size()) return n;
        } else {
            const double d = std::stod(v, &pos);
            if (pos == v.size()) return d;
        }
    } catch (...) {}
    return v;
}

// func(...) argument text → {key: value}. Splits on TOP-LEVEL commas (outside strings
// and brackets). Positional args (no '=') are skipped — tools take named args.
inline nlohmann::json pyArgs(const std::string& argStr) {
    nlohmann::json args = nlohmann::json::object();
    std::vector<std::string> parts;
    std::size_t start = 0; int depth = 0; bool inStr = false; char q = 0; bool esc = false;
    for (std::size_t i = 0; i < argStr.size(); ++i) {
        const char c = argStr[i];
        if (inStr) { if (esc) esc = false; else if (c == '\\') esc = true; else if (c == q) inStr = false; }
        else if (c == '"' || c == '\'') { inStr = true; q = c; }
        else if (c == '(' || c == '[' || c == '{') ++depth;
        else if (c == ')' || c == ']' || c == '}') --depth;
        else if (c == ',' && depth == 0) { parts.push_back(argStr.substr(start, i - start)); start = i + 1; }
    }
    parts.push_back(argStr.substr(start));
    for (const auto& part : parts) {
        const std::string t = trim(part);
        const auto eq = t.find('=');
        if (eq == std::string::npos || eq == 0) continue;
        const std::string key = trim(t.substr(0, eq));
        bool ident = !key.empty();
        for (char ch : key) if (!(std::isalnum(static_cast<unsigned char>(ch)) || ch == '_')) ident = false;
        if (ident) args[key] = pyValue(t.substr(eq + 1));
    }
    return args;
}
} // namespace detail

// Parse the LFM2 native format: a python-style list of calls [tool(arg="x"), t2()],
// optionally fenced by <|tool_call_start|>/<|tool_call_end|>. Pure string parsing — no
// Python is run. `isKnown` (optional) filters identifiers that are real tools, so a
// bare `foo()` in prose is not mistaken for a call; when empty, every `name(...)` is
// taken. Falls back to parsePlan when no python-style call is found (some LFM builds
// emit JSON / <tool_call> instead).
inline std::vector<ToolCall> parsePyToolCalls(
    const std::string& out, const std::function<bool(const std::string&)>& isKnown = {}) {
    std::vector<ToolCall> calls;
    static constexpr char kStart[] = "<|tool_call_start|>";
    static constexpr char kEnd[]   = "<|tool_call_end|>";
    std::string s = out;
    if (const auto a = out.find(kStart); a != std::string::npos) {
        const std::size_t from = a + (sizeof(kStart) - 1);
        const auto b = out.find(kEnd, from);
        s = out.substr(from, b == std::string::npos ? std::string::npos : b - from);
    }
    for (std::size_t i = 0; i < s.size();) {
        if (!(std::isalpha(static_cast<unsigned char>(s[i])) || s[i] == '_')) { ++i; continue; }
        const std::size_t nameStart = i;
        while (i < s.size() && (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '_')) ++i;
        const std::string name = s.substr(nameStart, i - nameStart);
        while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
        if (i >= s.size() || s[i] != '(') continue;   // identifier but not a call
        const std::size_t argStart = ++i;
        int depth = 1; bool inStr = false; char q = 0; bool esc = false;
        for (; i < s.size() && depth > 0; ++i) {
            const char c = s[i];
            if (inStr) { if (esc) esc = false; else if (c == '\\') esc = true; else if (c == q) inStr = false; }
            else if (c == '"' || c == '\'') { inStr = true; q = c; }
            else if (c == '(') ++depth;
            else if (c == ')') --depth;
        }
        if (depth != 0) break;   // unbalanced — stop
        const std::string argStr = s.substr(argStart, (i - 1) - argStart);   // without ')'
        if (!isKnown || isKnown(name))
            calls.push_back(ToolCall{name, detail::pyArgs(argStr)});
    }
    if (calls.empty()) return parsePlan(out);   // JSON / <tool_call> fallback
    return calls;
}

// Parse tool calls from model output according to `protocol`. PlanJson/Hammer/Mistral/
// Llama/Hermes all emit JSON (a plan, a [TOOL_CALLS] list, {"name","parameters"}, or
// <tool_call>{…}</tool_call>) which parsePlan scans out of surrounding prose; LfmPython
// is python-style. For the JSON protocols we still fall back to the python parser, which
// catches models (e.g. Llama 3.2) that emit python-style calls under a JSON protocol.
inline std::vector<ToolCall> parseToolCalls(const std::string& out, ToolProtocol protocol) {
    if (protocol == ToolProtocol::LfmPython) return parsePyToolCalls(out);
    std::vector<ToolCall> p = parsePlan(out);
    if (p.empty()) p = parsePyToolCalls(out);
    return p;
}

// ── Answer sanitising ───────────────────────────────────────────────────────────
// Strip leaked chat-template control tokens (a model "hallucinating" the next turn)
// and residual code fences from the final answer. A concrete token list (not a bare
// "<|") so legitimate prose with "<|" is left intact. A clean answer is unchanged.
inline std::string sanitizeAnswer(const std::string& in) {
    std::string s = in;
    for (const char* m : {"<|user|>", "<|assistant|>", "<|system|>", "<|im_start|>",
                          "<|im_end|>", "<|endoftext|>", "<|end|>", "<|eot_id|>",
                          "<|tool_call_start|>", "<|tool_call_end|>", "```json", "```JSON"})
        if (const auto p = s.find(m); p != std::string::npos) s = s.substr(0, p);
    for (std::size_t p; (p = s.find("```")) != std::string::npos;) s.erase(p, 3);
    return detail::trim(s);
}

// Did the model clearly ATTEMPT a tool call that failed to parse (even after repair)?
// If so, runAgent gives it one chance to reissue in valid form instead of treating the
// broken output as a final answer.
inline bool looksLikeToolAttempt(const std::string& a) {
    return a.find("tool_call") != std::string::npos ||
           a.find("\"plan\":[{") != std::string::npos ||
           a.find("\"arguments\"") != std::string::npos ||
           (a.find("\"tool\"") != std::string::npos && a.find("\"args\"") != std::string::npos);
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

// Tools as a JSON array for the NATIVE formats (Hermes/Mistral/Llama): {name,
// description(+example), parameters}. `params` is a human hint, not a real JSON schema,
// so `parameters` stays open ({"type":"object"}) and the example goes into description.
inline std::string toolsJsonForNative(const ToolRegistry& reg) {
    nlohmann::json arr = nlohmann::json::array();
    for (const Tool* t : reg.tools())
        arr.push_back({{"name", t->name},
                       {"description", t->description +
                            (t->params.empty() ? std::string() : " Example args: " + t->params)},
                       {"parameters", {{"type", "object"}}}});
    return arr.dump();
}

// Per-protocol system prompt. PlanJson delegates to the model-agnostic prompt above;
// the others emit the scaffolding each family was trained on (generic — no domain rules,
// which are the caller's job to append). All keep the "don't invent numbers" guardrail.
inline std::string systemPrompt(const ToolRegistry& reg, ToolProtocol protocol) {
    if (protocol == ToolProtocol::Hermes)
        return
            "You are a function-calling assistant. You are given function signatures in "
            "<tools></tools>. Decide which to call and return EACH call as a JSON object "
            "{\"name\":..., \"arguments\":...} inside <tool_call></tool_call> tags:\n<tools>\n"
            + toolsJsonForNative(reg) + "\n</tools>\n"
            "Example: <tool_call>\n{\"name\": \"<tool>\", \"arguments\": {}}\n</tool_call>\n"
            "Do NOT invent numbers — only state values returned by tools. "
            "If no function is needed, reply in plain text.\n";
    if (protocol == ToolProtocol::Mistral)
        return
            "You are a function-calling assistant. Available functions:\n"
            "[AVAILABLE_TOOLS] " + toolsJsonForNative(reg) + " [/AVAILABLE_TOOLS]\n"
            "When you need data, return the calls as a list: [TOOL_CALLS] "
            "[{\"name\": \"<tool>\", \"arguments\": {}}]. "
            "Do NOT invent numbers — only state values returned by tools. "
            "If no data is needed, reply in plain text.\n";
    if (protocol == ToolProtocol::Llama)
        return
            "Environment: ipython\n"
            "You are a function-calling assistant. Available functions (JSON):\n"
            + toolsJsonForNative(reg) + "\n"
            "When you need data, return a call as a JSON object "
            "{\"name\": \"<tool>\", \"parameters\": {}} (several allowed inside [ ... ]). "
            "Do NOT invent numbers — only state values returned by tools. "
            "If no data is needed, reply in plain text.\n";
    if (protocol == ToolProtocol::Hammer) {
        nlohmann::json toolsJson = nlohmann::json::array();
        for (const Tool* t : reg.tools())
            toolsJson.push_back({{"name", t->name}, {"description", t->description},
                                 {"example_arguments", t->params}});
        return
            "[BEGIN OF TASK INSTRUCTION]\n"
            "You are a function-calling assistant. Pick the needed functions and return their "
            "calls. Take numbers ONLY from function results — do not invent them. If no "
            "functions are needed, return an empty list [].\n"
            "[END OF TASK INSTRUCTION]\n\n"
            "[BEGIN OF AVAILABLE TOOLS]\n" + toolsJson.dump() + "\n[END OF AVAILABLE TOOLS]\n\n"
            "[BEGIN OF FORMAT INSTRUCTION]\n"
            "Your output must be STRICTLY a JSON list of calls and nothing else (no markdown, "
            "no ```):\n[{\"name\": \"function\", \"arguments\": {\"arg\": \"value\"}}]\n"
            "After receiving results, give a short final answer in plain text.\n"
            "[END OF FORMAT INSTRUCTION]\n";
    }
    if (protocol == ToolProtocol::LfmPython) {
        std::string p =
            "You are a helpful assistant that can call tools (read-only).\n"
            "When you need data, IMMEDIATELY call tools as a python-style list of calls "
            "between the special tokens, with no prose around them:\n"
            "<|tool_call_start|>[tool_name(arg=\"value\"), other_tool()]<|tool_call_end|>\n"
            "List all needed calls at once; the system executes them and returns results.\n"
            "If no data is needed, just answer with a short plain-text reply, without calls.\n"
            "Available tools (name — what it does; args — by example):\n";
        for (const Tool* t : reg.tools()) {
            p += "- " + t->name + " — " + t->description;
            if (!t->params.empty()) p += " Args (example): " + t->params;
            p += "\n";
        }
        p += "Rules: 1) Never invent numbers — only use tool results. 2) The name in a call "
             "is EXACTLY from the list above. 3) After receiving results, give a short final "
             "plain-text answer.\n";
        return p;
    }
    return systemPrompt(reg);   // PlanJson (default)
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

// Overall cap on tool executions per question — a runaway guard independent of maxRounds
// (a single plan can request many calls). Once hit, one closing generation synthesises
// the answer from what was gathered.
inline constexpr int kMaxToolCalls = 8;
// Long tool results are clipped before going back to the model: summaries/totals lead,
// so tail truncation is safe, and a bloated context slows and confuses weak models.
inline constexpr std::size_t kToolResultClip = 1800;

namespace detail {
// One-line "your call was invalid, reissue it" nudge, phrased for the protocol.
inline std::string retryHint(ToolProtocol p) {
    if (p == ToolProtocol::LfmPython)
        return "Your tool call was INVALID and could not be parsed. Repeat it EXACTLY as "
               "<|tool_call_start|>[tool_name(arg=\"value\")]<|tool_call_end|> — or, if no "
               "tools are needed, answer in plain text.";
    return "Your tool-call JSON was INVALID (syntax error) and could not be parsed. Repeat "
           "it EXACTLY as {\"plan\":[{\"name\":\"tool\",\"arguments\":{...}}]} — or, if no "
           "tools are needed, answer in plain text.";
}
} // namespace detail

inline AgentResult runAgent(IGenerator& gen, const ToolRegistry& reg,
                            const std::string& question, int maxRounds = 4,
                            ToolProtocol protocol = ToolProtocol::PlanJson,
                            const std::function<bool()>& cancelled = {}) {
    AgentResult res;
    auto stopped = [&] { return cancelled && cancelled(); };
    std::string prompt = systemPrompt(reg, protocol) + "\nUser: " + question + "\nAssistant:";
    int toolCalls = 0;                                   // global cap across rounds
    std::map<std::string, std::string> cache;            // per-request result dedup
    bool formatRetried = false;                          // one botched-format nudge, max
    // KV-cache note: the upstream engine feeds only the incremental segment on rounds>0
    // (a firstStep flag) so llama can reuse the KV cache. IGenerator::generate takes a full
    // prompt with no incremental hook, so aitc re-sends the growing prompt each round; an
    // adapter that caches can key off the shared prompt prefix. Left as a note, not a break.
    for (int round = 1; round <= std::max(1, maxRounds); ++round) {
        res.rounds = round;
        const std::string raw = gen.generate(prompt);
        const std::string answer = splitThinking(raw).answer;
        std::vector<ToolCall> plan = parseToolCalls(answer, protocol);
        // Drop unknown tools (weak models call a product/field name as if it were a tool).
        plan.erase(std::remove_if(plan.begin(), plan.end(),
                   [&](const ToolCall& c) { return !reg.has(c.tool); }), plan.end());
        // Cancellation: after generation, before executing anything.
        if (stopped()) {
            res.answer = plan.empty() ? sanitizeAnswer(answer) : std::string("Request cancelled.");
            return res;
        }
        // Botched but clearly-intended tool call → one chance to reissue in valid form.
        if (plan.empty() && !formatRetried && looksLikeToolAttempt(answer)) {
            formatRetried = true;
            prompt += answer + "\n" + detail::retryHint(protocol) + "\nAssistant:";
            continue;
        }
        if (plan.empty()) {                 // no tool calls → final answer
            res.answer = sanitizeAnswer(answer);
            return res;
        }
        std::string feedback = "\nTool results:\n";
        bool capped = false;
        for (const auto& call : plan) {
            if (toolCalls >= kMaxToolCalls) { capped = true; break; }
            ++toolCalls;
            res.calls.push_back(call);
            // Per-request cache: identical (tool, args) is not executed twice (weak models
            // re-request the same tool between rounds; read-only data is stable per question).
            const std::string key = call.tool + "|" + call.args.dump();
            std::string result;
            auto it = cache.find(key);
            if (it != cache.end()) result = it->second;
            else { result = reg.execute(call); cache.emplace(key, result); }
            feedback += call.tool + " => " +
                        detail::utf8Truncate(result, kToolResultClip, "\n…(result truncated)") + "\n";
            if (stopped()) { res.answer = "Request cancelled."; return res; }
        }
        if (capped) {
            feedback += "(tool-call limit reached; remaining calls skipped)\n";
            const std::string finalRaw = gen.generate(
                prompt + answer + feedback +
                "\nNow give the final answer in plain text, without any tool calls.\nAssistant:");
            res.answer = sanitizeAnswer(splitThinking(finalRaw).answer);
            return res;
        }
        // Append the think-STRIPPED answer (keeps the plan, drops the model's own <think>
        // tokens so reasoning doesn't accumulate in the growing context) + tool results.
        prompt += answer + feedback + "\nAssistant:";
    }
    // Rounds exhausted while the model kept tool-calling: do ONE closing generation to
    // synthesise a plain-text answer from the gathered results — don't discard them.
    const std::string finalRaw = gen.generate(
        prompt + " Now give the final answer in plain text, without any tool calls.");
    res.answer = sanitizeAnswer(splitThinking(finalRaw).answer);
    return res;
}

} // namespace aitc
