const { src, dest, watch } = require('gulp');
const ts = require('gulp-typescript');
const sass = require('gulp-sass');
const postcss = require('gulp-postcss');
const sourcemaps = require('gulp-sourcemaps');
const uglify = require('gulp-uglify-es').default;
const rename = require('gulp-rename');
const plumber = require('gulp-plumber');
const autoprefixer = require('autoprefixer');
const browserSync = require('browser-sync').create();
const cssmqpacker = require('css-mqpacker'); // prevent media query bubbling
const fs = require('fs').promises;
const cheerio = require('cheerio');
const clipboardy = require('clipboardy');


const mqoptions = {
    sort(a, b) {
        const regex = /(\d+)/g;
        const regex2 = /(\d+)/g;
        const aa = regex.exec(a);
        const bb = regex2.exec(b);
        let an = null;
        let bn = null;
        if (aa != null) {
            an = parseInt(aa);
        }
        if (bb != null) {
            bn = parseInt(bb);
        }
        if (a.indexOf('max-width') != -1 && b.indexOf('max-width') != -1) {
            if (an < bn) return 1;
            if (an > bn) return -1;
            return 0;
        }
        return a.localeCompare(b);
    }
};

const css = (cb) => {
    src('./scss/**/*.scss')
        .pipe(plumber())
        .pipe(sourcemaps.init())
        .pipe(sass())
        .pipe(postcss([autoprefixer(), cssmqpacker(mqoptions)]))
        .pipe(sourcemaps.write('.'))
        .pipe(dest('./css'))
        .pipe(browserSync.stream());

    cb();
};

const js = (cb) => {
    src('./index.js')
        .pipe(plumber())
        .pipe(uglify())
        .pipe(rename({
            suffix: '.min'
        }))
        .pipe(dest('./'))
        .pipe(browserSync.stream());

    cb();
};

const tsProject = ts.createProject({
    declaration: true
});

const tsc = (cb) => {
    src('./index.ts')
        .pipe(plumber())
        .pipe(tsProject())
        .pipe(dest('./'));

    cb();
};

const createSnippetSO = (cb) => {
    var snipJS = '<!-- language: lang-js -->\n\n';
    var snipCSS = '<!-- language: lang-css -->\n\n';
    var snipHTML = '<!-- language: lang-html -->\n\n';

    const createSnippetsParts = async() => {
        snipJS += await fs.readFile('./index.js', 'utf8', function(err, content) {
            return content;
        });

        snipCSS += await fs.readFile('./css/style.css', 'utf8', function(err, content) {
            return content;
        });

        const tmpHTML = await fs.readFile('./index.html', 'utf8', function(err, content) {
            return content;
        });

        const $ = cheerio.load(tmpHTML);
        $('body > #indexjs').remove();
        snipHTML += $('body').html().trim();

        return;
    }

    createSnippetsParts().then(() => {
        const snipComplete = `<!-- begin snippet: js hide: false console: true babel: false -->
${snipJS}
${snipCSS}
${snipHTML}
<!-- end snippet -->`;

        console.log(snipComplete);
        clipboardy.writeSync(snipComplete);
    });


    cb();
}

const watcher = () => {
    browserSync.init({
        server: {
            basedir: './'
        }
    });

    watch('./scss/**/*.scss', css);
    watch('./index.js', js);
    watch('./index.ts', tsc);
    watch('./*.html').on('change', browserSync.reload);
};

exports.css = css;
exports.watch = watcher;
exports.default = watcher;
exports.snippet = createSnippetSO;
