// 验收用例：时限判定。
//
// 计数器必须是 volatile：否则 -O2 会认为这个无限空循环没有可观测副作用而整段删掉，
// 程序瞬间正常退出，判成 AC 而不是 TLE。
int main() {
  volatile unsigned long long counter = 0;
  for (;;) {
    counter = counter + 1;
  }
}
