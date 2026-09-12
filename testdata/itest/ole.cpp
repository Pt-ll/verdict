#include <cstdio>

// 验收用例：输出超限。输出上限由 testdata/itest/.vscode/settings.json 设为 64KB，
// 这里一直写到被杀掉为止。
int main() {
  for (;;) {
    std::fputs("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz\n", stdout);
  }
}
