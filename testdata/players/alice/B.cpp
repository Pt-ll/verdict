#include <cstdio>

// Alice 的 B 题：读 n 个数取最大值。
int main() {
  int n = 0;
  if (std::scanf("%d", &n) != 1 || n <= 0) {
    return 1;
  }
  long long best = 0;
  for (int i = 0; i < n; i += 1) {
    long long value = 0;
    if (std::scanf("%lld", &value) != 1) {
      return 1;
    }
    if (i == 0 || value > best) {
      best = value;
    }
  }
  std::printf("%lld\n", best);
  return 0;
}
