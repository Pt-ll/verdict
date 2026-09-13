#include <cstdio>

// 标准做法：读两个整数求和。用 long long，大数据才不会溢出。
int main() {
  long long a = 0;
  long long b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) {
    return 1;
  }
  std::printf("%lld\n", a + b);
  return 0;
}
