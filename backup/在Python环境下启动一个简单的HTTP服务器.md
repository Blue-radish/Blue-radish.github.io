# 快速搭建本地服务器：Python 的 http.server 模块

## 引言

可以用在局域网下小组成员间快速传递文件。

## 第一部分：http.server 模块简介

`http.server` 是Python标准库中的一个模块，它提供了一个简单的HTTP服务器，用于托管当前目录下的文件。它不需要任何额外的安装或配置，有python就行。

## 第二部分：如何使用 http.server

要启动一个简单的HTTP服务器，你可以按照以下步骤操作：

### Step 1: 

打开你的计算机上的命令行工具。在Windows上用命令提示符（cmd）或PowerShell，在macOS或Linux上直接用终端。使用 `cd` 命令（change directory）切换到你想要共享文件的目录。例如，如果你的文件位于 `C:\temp` 目录下，你可以输入以下命令：
```bash
cd C:\temp
```

或者先在文件管理器里打开目标目录，再打开命令行工具。
![Image](https://github.com/user-attachments/assets/832d6928-7397-4e2e-8fd3-55551de38d63)

或是在导航条填入cmd然后回车
![Image](https://github.com/user-attachments/assets/1f0f70fb-05a2-48ed-b785-25be423a4c2c)

### Step 2: 

进入python环境，如果你有一个conda环境叫 ml ，你可以输入以下命令：
```bash
conda activate ml
```

然后在想共享的文件夹的路径下执行：
```bash
python -m http.server 8080
```
此时HTTP服务器就已经开启了，端口为8080。
![Image](https://github.com/user-attachments/assets/b75f5e72-fbfe-43dc-aa18-b99d9ee9f55a)

### Step 3: 

告诉对方你的IP地址，如果你不知道你自己的IP是多少，可以在命令行里输入：
```bash
ipconfig
```


### Step 4: 
对方得知你的IP是192.168.0.2，端口是8080。打开浏览器，输入：
```bash
192.168.0.2:8080
```
![Image](https://github.com/user-attachments/assets/45d7451c-0f08-4400-af7f-96d1602d3548)
这时候就能畅快下载对方电脑指定路径下的数据了。

## 第三部分：可能出现的问题

### 其一: 
端口被占用。换一个端口就行。