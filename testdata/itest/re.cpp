#include <cstdio>

// 验收用例：运行时错误。空指针写入必然触发 SIGSEGV，而不是靠退出码来伪装。
int main() {
  std::printf("about to crash\n");
  volatile int *p = nullptr;
  *p = 1;
  return 0;
}
