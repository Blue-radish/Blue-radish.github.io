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
### print
输出内容到控制台。
参数：*values（多个值）, sep=' '（分隔符）, end='\n'（结束符）, file=sys.stdout（输出流）, flush=False（是否强制刷新）。

### type
返回对象的类型。
参数：object（要检查的对象）。

### range
生成整数序列。
参数：start（起始值，默认 0）, stop（结束值）, step=1（步长）。

### enumerate
返回带索引的迭代器。
参数：iterable（可迭代对象）, start=0（起始索引）。

### zip
将多个可迭代对象组合为元组迭代器。
参数：*iterables（多个可迭代对象）。

### ord
返回字符的 Unicode 码点。
参数：char（单个字符）。

### chr
返回 Unicode 码点对应的字符。
参数：integer（整数码点）。

### reversed
反转序列并返回迭代器。
参数：seq（可反转的序列，如列表、元组）。

### sorted
返回排序后的新列表。
参数：iterable（可迭代对象）, key=None（排序规则）, reverse=False（是否降序）。

### round
四舍五入浮点数。
参数：number（要舍入的数）, ndigits=0（保留小数位数）。

### map
对可迭代对象应用函数。
参数：func（函数）, iterable（可迭代对象，可传多个）。


## 常用方法
### 字符串
#### split(sep=None, maxsplit=-1)
按 sep 分割字符串，返回列表。maxsplit 指定最大分割次数。
#### join(iterable)
将 iterable 中的元素用当前字符串连接。
#### upper() / lower()
返回全大写/全小写字符串（无参数）。
#### strip(chars=None)
去除两侧的 chars 字符（默认去空格）。
#### lstrip() / rstrip()
仅去除左侧/右侧字符（参数同 strip）。
#### find(sub, start=0, end=None)
返回 sub 首次出现的索引，找不到返回 -1。
#### replace(old, new, count=-1)
替换 old 为 new，count 指定替换次数（默认全部）。
#### count(sub, start=0, end=None)
统计 sub 出现的次数。
#### startswith(prefix, start=0, end=None)
检查是否以 prefix 开头（支持元组多匹配）。
#### endswith(suffix, start=0, end=None)
检查是否以 suffix 结尾（用法同 startswith）。

### 字典
#### get(key, default=None)
返回 key 对应的值，不存在时返回 default（默认 None）。
#### setdefault(key, default=None)
若 key 存在返回其值，否则设置 key: default 并返回 default。
#### update(other_dict/iterable, **kwargs)
合并字典或键值对（可接受另一个字典、键值对列表，或关键字参数）。
#### pop(key, default)
删除 key 并返回其值，若 key 不存在且未提供 default 则报错。
#### keys() / values() / items()
返回键、值、键值对的动态视图（无参数）。
#### dict.fromkeys(iterable, value=None)（类方法）
用 iterable 的元素作为键，所有值设为 value（默认 None）。

## 常用包
### math