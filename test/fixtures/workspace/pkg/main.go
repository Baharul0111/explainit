package main

import (
	"fmt"
	"strings"
)

// Reverse returns the string with its characters in reverse order.
func Reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}

type Counter struct {
	counts map[string]int
}

func (c *Counter) Add(word string) {
	if c.counts == nil {
		c.counts = map[string]int{}
	}
	c.counts[strings.ToLower(word)]++
}

func main() {
	fmt.Println(Reverse("hello"))
}
