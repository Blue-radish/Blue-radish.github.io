## 模板
```bash
import sys

def main():
    # 主逻辑代码

if __name__ == "__main__":
    main()
```

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
- print(*values, sep=' ', end='\n', file=sys.stdout, flush=False)
输出内容到控制台。`*values` 表示多个值，`sep` 是分隔符，默认为空格，`end` 是结束符，默认为换行符，`file` 是输出流，默认为标准输出，`flush` 表示是否强制刷新，默认为 False。
- type(object)
返回对象的类型。`object` 是要检查的对象。
- range(start, stop, step=1)
生成整数序列。`start` 是起始值，默认为 0，`stop` 是结束值，`step` 是步长，默认为 1。
- enumerate(iterable, start=0)
返回带索引的迭代器。`iterable` 是可迭代对象，`start` 是起始索引，默认为 0。
- zip(*iterables)
将多个可迭代对象组合为元组迭代器。`*iterables` 是多个可迭代对象。
- ord(char)
返回字符的 Unicode 码点。`char` 是单个字符。
- chr(integer)
返回 Unicode 码点对应的字符。`integer` 是整数码点。
- reversed(seq)
反转序列并返回迭代器。`seq` 是可反转的序列，如列表、元组。
- sorted(iterable, key=None, reverse=False)
返回排序后的新列表。`iterable` 是可迭代对象，`key` 是排序规则，默认为 None，`reverse` 表示是否降序，默认为 False。
- round(number, ndigits=0)
四舍五入浮点数。`number` 是要舍入的数，`ndigits` 是保留小数位数，默认为 0。
- map(func, iterable)
对可迭代对象应用函数。`func` 是函数，`iterable` 是可迭代对象，可传多个。


## 常用方法
### 字符串
- split(sep=None, maxsplit=-1)
按 sep 分割字符串，返回列表。maxsplit 指定最大分割次数。
- join(iterable)
将 iterable 中的元素用当前字符串连接。
- upper() / lower()
返回全大写/全小写字符串（无参数）。
- strip(chars=None)
去除两侧的 chars 字符（默认去空格）。
- lstrip() / rstrip()
仅去除左侧/右侧字符（参数同 strip）。
- find(sub, start=0, end=None)
返回 sub 首次出现的索引，找不到返回 -1。
- replace(old, new, count=-1)
替换 old 为 new，count 指定替换次数（默认全部）。
- count(sub, start=0, end=None)
统计 sub 出现的次数。
- startswith(prefix, start=0, end=None)
检查是否以 prefix 开头（支持元组多匹配）。
- endswith(suffix, start=0, end=None)
检查是否以 suffix 结尾（用法同 startswith）。

### 字典
- get(key, default=None)
返回 key 对应的值，不存在时返回 default（默认 None）。
- setdefault(key, default=None)
若 key 存在返回其值，否则设置 key: default 并返回 default。
- update(other_dict/iterable, **kwargs)
合并字典或键值对（可接受另一个字典、键值对列表，或关键字参数）。
- pop(key, default)
删除 key 并返回其值，若 key 不存在且未提供 default 则报错。
- keys() / values() / items()
返回键、值、键值对的动态视图（无参数）。
- dict.fromkeys(iterable, value=None)（类方法）
用 iterable 的元素作为键，所有值设为 value（默认 None）。

### 列表
- append(obj)
在列表末尾添加单个元素 obj。
- extend(iterable)
将 iterable 的元素逐个添加到列表末尾。
- insert(index, obj)
在指定 index 处插入 obj，原元素后移。
- remove(obj)
删除第一个匹配的 obj，不存在时抛出 ValueError。
- pop(index=-1)
删除并返回指定 index 处的元素（默认最后一个）。
- index(obj, start=0, end=None)
返回 obj 第一次出现的索引，不存在时抛出 ValueError。
- count(obj)
统计 obj 在列表中出现的次数。
- sort(key=None, reverse=False)
原地排序列表，key 指定排序规则，reverse 控制降序。
- reverse()
原地反转列表（无参数）。

### 元组
- count(obj)
统计 obj 在元组中出现的次数。
- index(obj, start=0, end=None)
返回 obj 第一次出现的索引，不存在时抛出 ValueError。

### 集合
- add(obj)
向集合添加一个元素 obj。
- remove(obj) / discard(obj)
删除集合中的 obj，remove 在元素不存在时抛出 KeyError，discard 不会报错。
- union(*others) / |
返回当前集合与其他集合的并集（不修改原集合）。
- intersection(*others) / &
返回当前集合与其他集合的交集。
- difference(*others) / -
返回当前集合与其他集合的差集（当前有但其他没有的元素）。
- symmetric_difference(other) / ^
返回当前集合与 other 的对称差集（仅出现在其中一个集合的元素）。

## 常用库
### math
- ceil(x)
向上取整（返回 ≥ x 的最小整数）。
- floor(x)
向下取整（返回 ≤ x 的最大整数）。
- fabs(x)
返回 x 的绝对值（浮点数形式）。
- gcd(a, b)
返回 a 和 b 的最大公约数。
- pow(x, y)
返回 x 的 y 次方（结果为浮点数，与内置 ** 不同）。
- sqrt(x)
返回 x 的平方根。
- log(x, base=math.e)
返回 x 的对数（默认自然对数，base 可指定底数）。
- factorial(x)
返回 x 的阶乘（x 必须为非负整数）。

### collections
#### Counter类
将对象按照其中元素的出现次数，自动转化为一个类似字典的计数类。与字典大同小异，但是可以进行计算。
```bash
from collections import Counter
c = Counter("hello")  # Counter({'h':1, 'e':1, 'l':2, 'o':1})
```
- most_common(n=None)
返回前 n 个最常见元素（默认全部）。
```bash
c.update("world")  # Counter({'h':1, 'e':1, 'l':3, 'o':2, 'w':1, 'r':1, 'd':1})
```
- update(iterable)
合并其他计数器或可迭代对象。参数iterable为可迭代对象或 Counter。
- subtract(iterable)
减去其他计数器的值（允许负值）。参数iterable为可迭代对象或 Counter。

#### deque类
双端列表，使用方法和普通列表类似，不同的是其可以在列表两端以 O(1) 的复杂度入队、出队，在单调队列、广度搜索 BFS 等题目中使用较多。
- append(x) / appendleft(x)
在右端/左端添加元素 x。
- pop() / popleft()
移除并返回右端/左端元素（队列为空时报错）。
- extend(iterable) / extendleft(iterable)
在右端/左端批量添加元素（extendleft 会逆序插入）。
- rotate(n=1)
向右循环移动 n 步（n 为负则向左移动）。

### heapq
堆模块。由于堆的数据结构有着 O(logn) 的优秀的算法复杂度，所以在求最值的时候，使用堆往往更加快捷。最小堆。
- heapify(x)
将普通列表 x 原地转换为最小堆（时间复杂度 O(n)）。
- heappush(heap, item)
将 item 插入堆，保持堆结构。
- heappop(heap)
弹出并返回堆中最小元素（堆大小减 1）。
- nlargest(n, iterable, key=None)
返回可迭代对象中最大的 n 个元素（无需堆化）。
- nsmallest(n, iterable, key=None)
返回可迭代对象中最小的 n 个元素。

### itertools
- permutations(iterable, r=None)
生成 iterable 中长度为 r 的排列（顺序敏感）。
```bash
list(itertools.permutations("ABC", 2))  # [('A','B'), ('A','C'), ('B','A'), ...]
```
- combinations(iterable, r)
生成 iterable 中长度为 r 的组合（顺序无关）。
```bash
list(itertools.combinations("ABC", 2))  # [('A','B'), ('A','C'), ('B','C')]
```

- combinations_with_replacement(iterable, r)
允许元素重复的组合。
```bash
list(itertools.combinations_with_replacement("AB", 2))  # [('A','A'), ('A','B'), ('B','B')]
```