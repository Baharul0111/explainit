/// Adds two numbers.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub struct Stack {
    items: Vec<i32>,
}

impl Stack {
    pub fn new() -> Self {
        Stack { items: Vec::new() }
    }

    pub fn push(&mut self, value: i32) {
        self.items.push(value);
    }

    pub fn pop(&mut self) -> Option<i32> {
        self.items.pop()
    }
}
