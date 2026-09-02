#include <cmath>

namespace shapes {

double circleArea(double radius) {
    return M_PI * radius * radius;
}

class Rect {
public:
    Rect(double w, double h) : w_(w), h_(h) {}
    double area() const { return w_ * h_; }
private:
    double w_;
    double h_;
};

}  // namespace shapes
