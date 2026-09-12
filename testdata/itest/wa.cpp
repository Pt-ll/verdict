#include <cstdio>

// 验收用例：答案比较。故意写成 a - b，会得到 WA 并报出第 1 行不同。
int main() {
  int a = 0;
  int b = 0;
  if (std::scanf("%d %d", &a, &b) != 2) {
    return 1;
  }
  std::printf("%d\n", a - b);
  return 0;
}
