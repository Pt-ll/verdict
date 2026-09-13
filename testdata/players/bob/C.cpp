#include <iostream>
#include <string>

// Bob 的 C 题：同样的二分。这样他只在 A 题掉分，一眼能看出是哪道题的问题。
int main() {
  long long low = 1;
  long long high = 100;
  for (;;) {
    const long long mid = (low + high) / 2;
    std::cout << mid << std::endl;

    std::string reply;
    if (!(std::cin >> reply)) {
      return 0;
    }
    if (reply == "ok") {
      return 0;
    }
    if (reply == "bigger") {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
}
