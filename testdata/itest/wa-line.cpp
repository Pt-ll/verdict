#include <cstdio>

// 验收用例：diff 要跳到「首个不同行」。这里第 3 行故意不同（答案是 X），
// 前两行一样，用来验证定位的不是第 1 行。
int main() {
  std::printf("1\n2\n3\n");
  return 0;
}
