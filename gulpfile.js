const { src, dest, watch } = require('gulp');
const sass = require('gulp-sass');
const postcss = require('gulp-postcss');
const sourcemaps = require('gulp-sourcemaps');
const uglify = require('gulp-uglify-es').default;
const rename = require('gulp-rename');
const autoprefixer = require('autoprefixer');
const browserSync = require('browser-sync').create();

const css = (cb) => {
  src('./scss/**/*.scss')
    .pipe(sourcemaps.init())
    .pipe(sass().on('error', sass.logError))
    .pipe(postcss([autoprefixer()]))
    .pipe(sourcemaps.write('.'))
    .pipe(dest('./css'))
    .pipe(browserSync.stream());

  cb();
};

const js = (cb) => {
  src('./index.js')
    .pipe(uglify())
    .pipe(rename({ suffix: '.min' }))
    .pipe(dest('./'))
    .pipe(browserSync.stream());

  cb();
};

const watcher = (cb) => {
  browserSync.init({
    server: {
      basedir: './'
    }
  });

  watch('./scss/**/*.scss', css);
  watch('./index.js', js);
  watch('./*.html').on('change', browserSync.reload);

  cb();
};

exports.css = css;
exports.watch = watcher;
exports.default = watcher;
