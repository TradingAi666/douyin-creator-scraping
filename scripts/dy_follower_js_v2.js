(function(){
    var result = {fans: 0};
    var body = document.body.innerText;
    var m = body.match(/\u5173\u6ce8\s*[\d,]+\s*\u7c89\u4e1d\s*([\d.]+)\s*\u4e07/);
    if (m) {
        result.fans = Math.round(parseFloat(m[1]) * 10000);
        result.after = m[0];
    }
    result.bodyHead = body.substring(0, 200);
    return JSON.stringify(result);
})()
