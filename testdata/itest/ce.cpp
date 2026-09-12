#include <cstdio>

// 验收用例：编译失败。
// 下面这行是刻意的语法错误（赋值号右边缺了操作数），
// test/integration/index.js 靠那行代码的文本定位期望的报错行。
int main() {
  int answer = ;
  std::printf("%d\n", answer);
  return 0;
}
