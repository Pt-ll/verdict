#include <iostream>
#include <string>

// Alice 的 C 题：二分猜数字。交互题的读写都要走 std::cin / std::cout。
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
