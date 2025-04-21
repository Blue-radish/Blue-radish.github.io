## 输入
用input()
```bash
n, m = map(int, input().split()) # 接收两个整数，以空格隔开
arr = list(map(int, input().split())) # 接收 n 个整数的数组，以空格隔开
```

使用 sys.stdin.readline() 替代 input() 提高输入速度。要注意的是，readlines() 获取到的字符串列表通常会包含一个换行符“\n”，在进行处理的时候，根据需要使用 strip() 或 rstrip() 将最右边的换行符去掉。
```bash
import sys
s = sys.stdin.readline()
```

对整数输入，推荐用 map(int, ...) 快速转换。多行输入可使用 sys.stdin.readlines() 一次性读取，再逐行处理。
```bash
n, m = map(int, sys.stdin.readline().split()) # 接收两个整数，以空格隔开
arr = list(map(int, sys.stdin.readline().split())) # 接收 n 个整数的数组，以空格隔开
```

如果输入数据量极大（如 1e6 行），readlines() 会一次性读取所有内容，可能占用较多内存。此时更推荐 逐行读取
```bash
for line in sys.stdin:  # 逐行读取，内存友好
    line = line.strip()
    # 处理逻辑
```

## 输出
使用 print(*list) 解包列表输出空格分隔的结果，换行输出时设置 sep='\n'。
```bash
print(*result, sep = "\n")
```

## 常用函数
### 

## 常用方法
### 字典
#### setdefault()