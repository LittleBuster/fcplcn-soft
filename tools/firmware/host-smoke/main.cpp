#include <chrono>
#include <climits>
#include <cstdlib>
#include <iostream>
#include <numeric>
#include <optional>
#include <thread>
#include <vector>

static_assert(__cplusplus >= 201703L, "A C++17 compiler is required");

int main()
{
    const auto started_at = std::chrono::steady_clock::now();
    const std::vector<int> values{1, 2, 3, 4};
    std::optional<int> result;

    std::thread worker([&] {
        result.emplace(std::accumulate(values.begin(), values.end(), 0));
    });
    worker.join();

    if (result != 10) {
        std::cerr << "FCPLCn host toolchain smoke test failed\n";
        return EXIT_FAILURE;
    }

    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - started_at);
    std::cout << "FCPLCn host C++17 toolchain smoke test passed (" << sizeof(void*) * CHAR_BIT
              << "-bit, " << elapsed.count() << " us)\n";
    return EXIT_SUCCESS;
}
