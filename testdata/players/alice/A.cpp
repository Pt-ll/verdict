#include <cstdio>

// Alice 的 A 题：用 long long，大小数据都对。
int main() {
  long long a = 0;
  long long b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) {
    return 1;
  }
  std::printf("%lld\n", a + b);
  return 0;
}
