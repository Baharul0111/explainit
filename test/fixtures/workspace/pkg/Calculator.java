public class Calculator {
    private int total = 0;

    public void add(int value) {
        total += value;
    }

    public void reset() {
        total = 0;
    }

    public int getTotal() {
        return total;
    }

    public static int square(int x) {
        return x * x;
    }
}
