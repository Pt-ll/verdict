#include <cstdio>

// Bob 的 B 题：做对了。这样榜单上 Bob 是「A 部分分 + B 满分」，
// 一眼能看出哪道题拖了他后腿。
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
