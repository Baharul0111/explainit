// Plain JavaScript helpers.
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const debounce = function (fn, wait) {
  let timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
};

module.exports = { clamp, debounce };
