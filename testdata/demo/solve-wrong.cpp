#include <cstdio>

// 故意写错成减法：用来验证 WA 与 diff 展示。
// 它没有同名的 solve-wrong.in/out，因此会落到目录扫描，复用 solve.in / solve.out。
int main() {
  int a = 0;
  int b = 0;
  if (std::scanf("%d %d", &a, &b) != 2) {
    return 1;
  }
  std::printf("%d\n", a - b);
  return 0;
}
