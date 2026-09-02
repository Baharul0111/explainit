#include <stdio.h>

/* Returns the larger of two integers. */
int max_int(int a, int b) {
    return a > b ? a : b;
}

static void print_line(const char *text) {
    printf("%s\n", text);
}

int main(void) {
    print_line("hello");
    return max_int(1, 2);
}
