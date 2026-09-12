#include <cstdio>

// 验收用例：正常通过。
int main() {
  int a = 0;
  int b = 0;
  if (std::scanf("%d %d", &a, &b) != 2) {
    return 1;
  }
  std::printf("%d\n", a + b);
  return 0;
}
