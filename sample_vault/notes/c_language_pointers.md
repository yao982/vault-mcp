# C 语言核心笔记：指针与内存管理

## 1. 指针的本质
在 C 语言中，指针变量本质上保存的是内存地址。
声明一个指向整型的指针：
```c
int a = 100;
int *p = &a; // p 保存变量 a 的首地址
```

## 2. 动态内存分配
通过 stdlib.h 提供的 malloc 和 free 手动管理堆内存：
```c
int *arr = (int *)malloc(10 * sizeof(int));
if (arr == NULL) {
    perror("内存分配失败");
    exit(1);
}
// 使用完毕必须手动释放，防止内存泄漏 (Memory Leak)
free(arr);
arr = NULL; // 避免野指针 (Dangling Pointer)
```
