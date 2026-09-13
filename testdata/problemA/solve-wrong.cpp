#include <cstdio>

// 故意只写对一半：小数据能过，大数据的和超过 int 范围就错了。
// 用 static_cast 显式截断，避免依赖有符号溢出的未定义行为。
int main() {
  long long a = 0;
  long long b = 0;
  if (std::scanf("%lld %lld", &a, &b) != 2) {
    return 1;
  }
  const long long sum = a + b;
  std::printf("%d\n", static_cast<int>(sum));
  return 0;
}
