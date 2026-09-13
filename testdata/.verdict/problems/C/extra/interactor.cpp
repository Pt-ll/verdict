#include <fstream>
#include <iostream>
#include <string>

// 手写的交互器：按 testlib 的协议对称（对话走 stdin/stdout，退出码表达判定），
// 但不需要真的 testlib.h——这样样例在离线、干净的环境里也能直接跑：
//   0 = AC，1 = WA，2 = PE，3 = 交互器自己的问题，7 = 部分分。
// 输入文件里放的是秘密数字，选手程序要猜出来。
int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: interactor input answer" << std::endl;
    return 3;
  }

  long long secret = 0;
  std::ifstream input(argv[1]);
  if (!(input >> secret)) {
    std::cerr << "读不到输入文件" << std::endl;
    return 3;
  }

  int guesses = 0;
  for (;;) {
    long long guess = 0;
    if (!(std::cin >> guess)) {
      std::cerr << "选手的输出不是数字，或者提前结束了" << std::endl;
      return 2;
    }
    guesses += 1;
    if (guess == secret) {
      std::cout << "ok" << std::endl;
      return 0;
    }
    if (guesses > 20) {
      std::cerr << "猜的次数太多（超过 20 次）" << std::endl;
      return 1;
    }
    std::cout << (guess < secret ? "bigger" : "smaller") << std::endl;
  }
}
