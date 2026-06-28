// Minimal end-to-end demo of aitc with a SCRIPTED "model" (no real LLM needed).
// Shows the whole platform: register a tool, run the agent, get an answer.
//
// In production, replace ScriptedGenerator with an IGenerator backed by
// llama.cpp / an HTTP endpoint / your inference of choice.
#include "aitc/aitc.hpp"
#include <iostream>
#include <vector>

// Returns canned completions in order — stands in for a model. The first reply is
// a tool-call plan; the second is the final answer after seeing the tool result.
class ScriptedGenerator : public aitc::IGenerator {
public:
    explicit ScriptedGenerator(std::vector<std::string> script)
        : script_(std::move(script)) {}
    std::string generate(const std::string& /*prompt*/) override {
        return i_ < script_.size() ? script_[i_++] : std::string("I don't know.");
    }
private:
    std::vector<std::string> script_;
    std::size_t i_ = 0;
};

int main() {
    // 1) Register your tools (the plugin point).
    aitc::ToolRegistry reg;
    reg.add("add", "Add two numbers", R"({"a": <num>, "b": <num>})",
            [](const nlohmann::json& a) {
                const double x = a.value("a", 0.0), y = a.value("b", 0.0);
                return std::to_string(x + y);
            });

    // 2) Bring your model. Here: a scripted stand-in that calls add(2,3) then answers.
    ScriptedGenerator gen({
        R"(Let me compute. [{"name":"add","arguments":{"a":2,"b":3}}])",
        "The sum of 2 and 3 is 5."
    });

    // 3) Run the agent — aitc parses the plan, calls your tool, feeds the result back.
    const aitc::AgentResult r = aitc::runAgent(gen, reg, "What is 2 + 3?");

    std::cout << "rounds : " << r.rounds << "\n";
    std::cout << "calls  : " << r.calls.size();
    if (!r.calls.empty()) std::cout << " (" << r.calls.front().tool << ")";
    std::cout << "\n";
    std::cout << "answer : " << r.answer << "\n";
    return 0;
}
